/* ankiLite — Frontend card viewer */

(function () {
  "use strict";

  const dropZone = document.getElementById("drop-zone");
  const viewer = document.getElementById("viewer");
  const loading = document.getElementById("loading");
  const btnOpen = document.getElementById("btn-open");
  const btnRecent = document.getElementById("btn-recent");
  const recentDropdown = document.getElementById("recent-dropdown");
  const recentList = document.getElementById("recent-list");
  const btnClearRecent = document.getElementById("btn-clear-recent");
  const btnBack = document.getElementById("btn-back");
  const btnSave = document.getElementById("btn-save");
  const btnSaveDropdown = document.getElementById("btn-save-dropdown");
  const saveDropdown = document.getElementById("save-dropdown");
  const btnSettings = document.getElementById("btn-settings");
  const settingsOverlay = document.getElementById("settings-overlay");
  const btnSettingsDone = document.getElementById("btn-settings-done");
  const deckTitle = document.getElementById("deck-title");
  const cardList = document.getElementById("card-list");
  const cardFields = document.getElementById("card-fields");
  const searchInput = document.getElementById("search-input");
  const filterImages = document.getElementById("filter-images");
  const sortOrder = document.getElementById("sort-order");
  const btnAddCard = document.getElementById("btn-add-card");
  const btnDeleteCard = document.getElementById("btn-delete-card");
  const deleteConfirmOverlay = document.getElementById("delete-confirm-overlay");
  const btnDeleteCancel = document.getElementById("btn-delete-cancel");
  const btnDeleteConfirm = document.getElementById("btn-delete-confirm");
  const btnEditor = document.getElementById("btn-editor");
  const btnPreview = document.getElementById("btn-preview");
  const cardPreview = document.getElementById("card-preview");
  const previewIframe = document.getElementById("preview-iframe");
  const btnFlip = document.getElementById("btn-flip");
  const contextMenu = document.getElementById("context-menu");
  const ctxShowInFinder = document.getElementById("ctx-show-in-finder");
  const btnCreate = document.getElementById("btn-create");
  const createDeckOverlay = document.getElementById("create-deck-overlay");
  const createDeckName = document.getElementById("create-deck-name");
  const btnCreateCancel = document.getElementById("btn-create-cancel");
  const btnCreateConfirm = document.getElementById("btn-create-confirm");
  const tagsList = document.getElementById("tags-list");
  const tagsInput = document.getElementById("tags-input");
  const importPreviewOverlay = document.getElementById("import-preview-overlay");
  const importInfo = document.getElementById("import-info");
  const importSample = document.getElementById("import-sample");
  const importTarget = document.getElementById("import-target");
  const btnImportCancel = document.getElementById("btn-import-cancel");
  const btnImportConfirm = document.getElementById("btn-import-confirm");

  let cards = [];
  let displayCards = [];
  let currentIndex = -1;
  let selectedFieldName = null;
  let selectedImg = null;
  let editingField = null;
  let models = {};
  let previewMode = false;
  let previewShowingBack = false;
  let contextMenuPath = null;
  let selectedFilterTags = [];
  let pendingImportPath = null;
  const tagFilterBar = document.getElementById("tag-filter-bar");
  const tagFilterToggle = document.getElementById("tag-filter-toggle");
  const tagFilterPills = document.getElementById("tag-filter-pills");

  // ── Filter & sort helpers ──

  function cardHasImages(card) {
    var fields = card.fields;
    for (var key in fields) {
      if (fields[key] && fields[key].indexOf("<img") !== -1) return true;
    }
    return false;
  }

  function getCardTitleText(card) {
    var fieldNames = Object.keys(card.fields);
    if (fieldNames.length === 0) return "";
    return stripHtml(card.fields[fieldNames[0]] || "").trim();
  }

  function getCardOriginalIndex(card) {
    var index = cards.indexOf(card);
    return index === -1 ? 9007199254740991 : index;
  }

  function compareCardTitles(a, b, direction) {
    var aTitle = getCardTitleText(a);
    var bTitle = getCardTitleText(b);
    var aEmpty = aTitle.length === 0;
    var bEmpty = bTitle.length === 0;
    if (aEmpty && bEmpty) return getCardOriginalIndex(a) - getCardOriginalIndex(b);
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    var result = aTitle.localeCompare(bTitle, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (result === 0) return getCardOriginalIndex(a) - getCardOriginalIndex(b);
    return direction === "desc" ? -result : result;
  }

  function parseSearchQuery(rawQuery) {
    var text = (rawQuery || "").trim();
    var tagOnly = text.toLowerCase().startsWith("tag:");
    if (tagOnly) {
      text = text.slice(4).trim();
    }

    var exact = text.length >= 2 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"';
    if (exact) {
      text = text.slice(1, -1).trim();
    }

    return {
      exact: exact,
      tagOnly: tagOnly,
      text: text.toLowerCase(),
    };
  }

  function normalizeSearchValue(value, stripMarkup) {
    var text = String(value || "");
    if (stripMarkup) {
      text = stripHtml(text);
    }
    return text.trim().toLowerCase();
  }

  function searchValueMatches(value, query, stripMarkup) {
    var candidate = normalizeSearchValue(value, stripMarkup);
    if (query.exact) {
      return candidate === query.text;
    }
    return candidate.indexOf(query.text) !== -1;
  }

  function cardFieldsMatchSearch(card, query) {
    var fields = card.fields || {};
    for (var key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key) && searchValueMatches(fields[key], query, true)) {
        return true;
      }
    }
    return false;
  }

  function cardTagsMatchSearch(card, query) {
    if (!card.tags) return false;
    return card.tags.some(function (tag) {
      return searchValueMatches(tag, query, false);
    });
  }

  function cardMatchesSearch(card, query) {
    if (query.tagOnly) {
      return cardTagsMatchSearch(card, query);
    }
    return cardFieldsMatchSearch(card, query) || cardTagsMatchSearch(card, query);
  }

  function applyFilterSort() {
    var filter = filterImages.value;
    var sort = sortOrder.value;

    // Filter
    var filtered;
    if (filter === "with-images") {
      filtered = cards.filter(cardHasImages);
    } else if (filter === "without-images") {
      filtered = cards.filter(function (c) { return !cardHasImages(c); });
    } else {
      filtered = cards.slice();
    }

    // Text search
    var query = parseSearchQuery(searchInput.value);
    if (query.text) {
      filtered = filtered.filter(function (card) {
        return cardMatchesSearch(card, query);
      });
    }

    // Tag filter (intersection — card must have ALL selected tags)
    if (selectedFilterTags.length > 0) {
      filtered = filtered.filter(function (card) {
        if (!card.tags) return false;
        return selectedFilterTags.every(function (ft) {
          return card.tags.indexOf(ft) !== -1;
        });
      });
    }

    // Sort
    if (sort === "alpha-asc") {
      filtered.sort(function (a, b) { return compareCardTitles(a, b, "asc"); });
    } else if (sort === "alpha-desc") {
      filtered.sort(function (a, b) { return compareCardTitles(a, b, "desc"); });
    } else if (sort === "created-desc") {
      filtered.sort(function (a, b) { return b.created_ts - a.created_ts; });
    } else if (sort === "created-asc") {
      filtered.sort(function (a, b) { return a.created_ts - b.created_ts; });
    } else if (sort === "modified-desc") {
      filtered.sort(function (a, b) { return b.mod_ts - a.mod_ts; });
    } else if (sort === "modified-asc") {
      filtered.sort(function (a, b) { return a.mod_ts - b.mod_ts; });
    } else if (sort === "tags") {
      filtered.sort(function (a, b) {
        var aTags = (a.tags && a.tags.length) ? a.tags.slice().sort() : null;
        var bTags = (b.tags && b.tags.length) ? b.tags.slice().sort() : null;
        if (!aTags && !bTags) return 0;
        if (!aTags) return 1;
        if (!bTags) return -1;
        var aKey = aTags.join("\0").toLowerCase();
        var bKey = bTags.join("\0").toLowerCase();
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
    }
    // "original" keeps the array order from cards.slice() or filtered

    displayCards = filtered;

    // Update title
    if (filter !== "all" || query.text || selectedFilterTags.length > 0) {
      deckTitle.textContent = displayCards.length + " of " + cards.length + " cards";
    } else {
      deckTitle.textContent = cards.length + " cards";
    }

    buildSidebar();
  }

  function restoreSelection(prevNoteId) {
    if (displayCards.length === 0) {
      currentIndex = -1;
      cardFields.innerHTML = "";
      return;
    }
    var found = -1;
    if (prevNoteId != null) {
      for (var i = 0; i < displayCards.length; i++) {
        if (displayCards[i].note_id === prevNoteId) {
          found = i;
          break;
        }
      }
    }
    showCard(found >= 0 ? found : 0);
  }

  // ── Toast notifications ──

  function showToast(message, duration) {
    duration = duration || 3000;
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    // Trigger reflow for animation
    toast.offsetHeight;
    toast.classList.add("toast-visible");
    setTimeout(function () {
      toast.classList.remove("toast-visible");
      setTimeout(function () { toast.remove(); }, 300);
    }, duration);
  }

  // ── Rendering helpers ──

  const HTML_TAG_RE = /<\/?[a-z][\s\S]*?>/i;

  function renderContent(text) {
    if (!text || !text.trim()) return '<span style="color:var(--text-secondary);">(empty)</span>';
    if (HTML_TAG_RE.test(text)) {
      return text;
    }
    return marked.parse(text);
  }

  function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  }

  // ── Multi-image layout helpers ──

  function stripImgRows(fieldEl) {
    var rows = fieldEl.querySelectorAll(".img-row");
    rows.forEach(function (row) {
      while (row.firstChild) {
        row.parentNode.insertBefore(row.firstChild, row);
      }
      row.remove();
    });
  }

  function layoutImages(fieldEl) {
    stripImgRows(fieldEl);
    var children = fieldEl.childNodes;
    var imgs = [];
    var hasSignificantText = false;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node.nodeType === 1 && node.tagName === "IMG") {
        imgs.push(node);
      } else if (node.nodeType === 1) {
        // Element node that isn't an img — check for text content
        var text = node.textContent.trim();
        if (text.length > 0) hasSignificantText = true;
      } else if (node.nodeType === 3) {
        // Text node
        var text = node.textContent.trim();
        if (text.length > 0) hasSignificantText = true;
      }
    }
    if (imgs.length >= 2 && imgs.length <= 4 && !hasSignificantText) {
      var row = document.createElement("div");
      row.className = "img-row";
      fieldEl.insertBefore(row, imgs[0]);
      imgs.forEach(function (img) { row.appendChild(img); });
    }
  }

  // ── Image & field selection ──

  function clearImgSelection() {
    if (selectedImg) {
      selectedImg.classList.remove("img-selected");
      selectedImg = null;
    }
  }

  function selectImg(imgEl) {
    clearImgSelection();
    selectedImg = imgEl;
    imgEl.classList.add("img-selected");
    // Also select the parent field
    var fieldEl = imgEl.closest(".field-value");
    if (fieldEl) selectField(fieldEl.dataset.fieldName);
  }

  function selectField(fieldName) {
    selectedFieldName = fieldName;
    document.querySelectorAll(".field-value").forEach(function (el) {
      el.classList.toggle("field-selected", el.dataset.fieldName === fieldName);
    });
  }

  // ── Inline editing helpers ──

  function saveFieldOnBlur(el, fieldName) {
    editingField = null;
    var card = displayCards[currentIndex];
    if (!card) return;
    stripImgRows(el);
    var newHtml = el.innerHTML;
    var oldHtml = card.fields[fieldName];
    layoutImages(el);
    if (newHtml === oldHtml) return;

    card.fields[fieldName] = newHtml;
    pywebview.api.update_field(card.note_id, fieldName, newHtml)
      .then(function (res) {
        if (!res.ok) {
          showToast("Save failed: " + res.error);
          return;
        }
      });

    // Rebuild sidebar if first or second field changed
    var fieldNames = Object.keys(card.fields);
    if (fieldName === fieldNames[0] || fieldName === fieldNames[1]) {
      updateSidebarItem(currentIndex);
    }
  }

  function updateSidebarItem(index) {
    var card = displayCards[index];
    var fieldNames = Object.keys(card.fields);
    var front = card.fields[fieldNames[0]] || "";
    var frontText = stripHtml(front).trim().substring(0, 80) || "(empty)";
    var sub = fieldNames.length > 1
      ? stripHtml(card.fields[fieldNames[1]] || "").trim().substring(0, 60)
      : "";
    var items = cardList.querySelectorAll(".card-item");
    if (items[index]) {
      items[index].innerHTML =
        '<span class="card-item-num">' + (index + 1) + '</span>' +
        '<div class="card-item-body">' +
        '<div class="card-item-title">' + escapeHtml(frontText) + '</div>' +
        (sub ? '<div class="card-item-sub">' + escapeHtml(sub) + '</div>' : "") +
        '</div>';
    }
  }

  // ── Anki template engine ──

  function renderAnkiTemplate(templateStr, fields, frontHtml) {
    if (!templateStr) return "";
    var result = templateStr;

    // {{FrontSide}} — insert rendered front (used in back templates)
    result = result.replace(/\{\{FrontSide\}\}/gi, frontHtml || "");

    // {{#Field}}...{{/Field}} — conditional: show block if field non-empty
    result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, function (match, name, content) {
      var val = fields[name];
      return (val && val.trim()) ? content : "";
    });

    // {{^Field}}...{{/Field}} — inverted conditional: show block if field empty
    result = result.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, function (match, name, content) {
      var val = fields[name];
      return (!val || !val.trim()) ? content : "";
    });

    // {{hint:Field}} — clickable hint
    result = result.replace(/\{\{hint:(\w+)\}\}/g, function (match, name) {
      var val = fields[name] || "";
      if (!val.trim()) return "";
      return '<a class="hint" onclick="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline\'">Show ' + name + '</a><span style="display:none">' + val + '</span>';
    });

    // {{type:Field}} — type-in answer placeholder
    result = result.replace(/\{\{type:(\w+)\}\}/g, function (match, name) {
      return '<input type="text" disabled placeholder="type ' + name + '" style="width:100%;padding:4px;border:1px solid #ccc;border-radius:4px;font-size:inherit;">';
    });

    // {{cloze:Field}} — cloze deletion rendering
    result = result.replace(/\{\{cloze:(\w+)\}\}/g, function (match, name) {
      var val = fields[name] || "";
      // Replace {{c1::answer::hint}} or {{c1::answer}} patterns
      val = val.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, function (m, num, answer, hint) {
        return '<span style="color:#00f;font-weight:bold">[' + (hint || answer) + ']</span>';
      });
      return val;
    });

    // {{FieldName}} — simple field substitution
    result = result.replace(/\{\{([^#^/!{}\s][^{}]*?)\}\}/g, function (match, name) {
      name = name.trim();
      if (name === "FrontSide") return frontHtml || "";
      if (fields.hasOwnProperty(name)) return fields[name] || "";
      return match;
    });

    return result;
  }

  function showPreview(index) {
    if (index < 0 || index >= displayCards.length) return;
    var card = displayCards[index];
    var modelId = String(card.model_id);
    var model = models[modelId];
    if (!model || !model.templates || model.templates.length === 0) {
      previewIframe.srcdoc = '<div style="padding:20px;color:#999;font-family:sans-serif;">No template available for this note type.</div>';
      return;
    }

    var ord = card.card_ord || 0;
    var tmpl = model.templates[ord] || model.templates[0];

    var frontHtml = renderAnkiTemplate(tmpl.qfmt, card.fields, "");
    var bodyHtml;
    if (previewShowingBack) {
      bodyHtml = renderAnkiTemplate(tmpl.afmt, card.fields, frontHtml);
      btnFlip.textContent = "Show Front";
    } else {
      bodyHtml = frontHtml;
      btnFlip.textContent = "Show Back";
    }

    var css = model.css || "";
    var doc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
      'body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 16px; }' +
      '.card { text-align: center; }' +
      'img { max-width: 100%; height: auto; }' +
      css +
      '</style></head><body><div class="card">' + bodyHtml + '</div></body></html>';

    previewIframe.srcdoc = doc;

    // Auto-size iframe height after content loads
    previewIframe.onload = function () {
      try {
        var h = previewIframe.contentDocument.body.scrollHeight;
        previewIframe.style.height = Math.max(h + 40, 200) + "px";
      } catch (e) {
        previewIframe.style.height = "400px";
      }
    };
  }

  // ── Card display ──

  function showCard(index) {
    if (index < 0 || index >= displayCards.length) return;
    currentIndex = index;

    if (previewMode) {
      previewShowingBack = false;
      showPreview(index);
    }

    const card = displayCards[index];
    const fieldNames = Object.keys(card.fields);

    let html = "";
    for (const name of fieldNames) {
      html +=
        '<div class="field-block">' +
          '<div class="field-label">' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<button class="btn-upload" data-field="' + escapeHtml(name) + '" title="Add image from file">+img</button>' +
          '</div>' +
          '<div class="field-value" contenteditable="true" data-field-name="' + escapeHtml(name) + '">' +
            renderContent(card.fields[name]) +
          '</div>' +
        '</div>';
    }
    cardFields.innerHTML = html;

    // Apply multi-image layout to each field
    document.querySelectorAll(".field-value").forEach(function (el) {
      layoutImages(el);
    });

    // Bind field focus/blur for inline editing
    document.querySelectorAll(".field-value").forEach(function (el) {
      el.addEventListener("focus", function () {
        editingField = el.dataset.fieldName;
        selectField(el.dataset.fieldName);
      });
      el.addEventListener("blur", function () {
        saveFieldOnBlur(el, el.dataset.fieldName);
      });
      el.addEventListener("click", function () {
        selectField(el.dataset.fieldName);
      });
    });

    // Bind upload buttons
    document.querySelectorAll(".btn-upload").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        handleUpload(btn.dataset.field);
      });
    });

    // Bind image mousedown for selection (mousedown + preventDefault avoids contenteditable interference)
    document.querySelectorAll(".field-value").forEach(function (el) {
      el.addEventListener("mousedown", function (ev) {
        var img = ev.target.closest("img");
        if (img) {
          ev.preventDefault();
          ev.stopPropagation();
          if (document.activeElement && document.activeElement.classList.contains("field-value")) {
            document.activeElement.blur();
          }
          selectImg(img);
        }
      });
    });

    // Bind drag-and-drop for image files
    document.querySelectorAll(".field-value").forEach(function (el) {
      el.addEventListener("dragover", function (e) {
        el.contentEditable = "false";
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("drop-target");
      });
      el.addEventListener("dragleave", function (e) {
        el.contentEditable = "true";
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drop-target");
      });
      el.addEventListener("drop", function (e) {
        el.contentEditable = "true";
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drop-target");

        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files || files.length === 0) return;

        var fieldName = el.dataset.fieldName;
        var card = displayCards[currentIndex];
        if (!card) return;

        for (var i = 0; i < files.length; i++) {
          (function (file) {
            if (file.type.indexOf("image/") !== 0) return;

            var reader = new FileReader();
            reader.onload = function () {
              var base64Data = reader.result.split(",")[1];
              pywebview.api.paste_image(card.note_id, fieldName, base64Data, file.type)
                .then(function (res) {
                  if (!res.ok) {
                    showToast("Drop failed: " + res.error);
                    return;
                  }
                  card.fields[fieldName] += '<img src="' + res.data_uri + '">';
                  var emptySpan = el.querySelector('span[style]');
                  if (emptySpan && emptySpan.textContent === "(empty)") {
                    emptySpan.remove();
                  }
                  var img = document.createElement("img");
                  img.src = res.data_uri;
                  el.appendChild(img);
                  layoutImages(el);
                  showToast("Image added");
                  if (filterImages.value !== "all") {
                    var prevNoteId = card.note_id;
                    applyFilterSort();
                    restoreSelection(prevNoteId);
                  }
                });
            };
            reader.readAsDataURL(file);
          })(files[i]);
        }
      });
    });

    // Clear image selection when switching cards
    clearImgSelection();
    editingField = null;

    // Auto-select last field (typically the answer/back field)
    if (fieldNames.length > 0) {
      selectField(fieldNames[fieldNames.length - 1]);
    }

    // Update sidebar active state
    document.querySelectorAll(".card-item").forEach(function (el, i) {
      el.classList.toggle("active", i === index);
    });

    // Render tags
    renderTags(card);

    var activeItem = cardList.querySelector(".card-item.active");
    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    document.getElementById("card-display").scrollTop = 0;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // ── Tags UI ──

  function renderTags(card) {
    tagsList.innerHTML = "";
    if (!card || !card.tags) return;
    card.tags.forEach(function (tag) {
      var pill = document.createElement("span");
      pill.className = "tag-pill";
      pill.innerHTML = escapeHtml(tag) + '<button class="tag-remove">&times;</button>';
      pill.querySelector(".tag-remove").addEventListener("click", function () {
        removeTag(card, tag);
      });
      tagsList.appendChild(pill);
    });
  }

  function removeTag(card, tag) {
    card.tags = card.tags.filter(function (t) { return t !== tag; });
    renderTags(card);
    persistTags(card);
  }

  function persistTags(card) {
    pywebview.api.update_tags(card.note_id, card.tags)
      .then(function (res) {
        if (!res.ok) showToast("Tag save failed: " + res.error);
        buildTagFilterBar();
      });
  }

  function buildTagFilterBar() {
    tagFilterPills.innerHTML = "";
    var tagCounts = {};
    cards.forEach(function (card) {
      if (!card.tags) return;
      card.tags.forEach(function (tag) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });
    var tagNames = Object.keys(tagCounts).sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
    });
    if (tagNames.length === 0) {
      tagFilterBar.classList.add("hidden");
      return;
    }
    tagFilterBar.classList.remove("hidden");
    // Update toggle label with active count
    var activeCount = selectedFilterTags.length;
    tagFilterToggle.textContent = activeCount > 0 ? "Tags (" + activeCount + ")" : "Tags";
    if (activeCount > 0) {
      tagFilterToggle.classList.add("has-active");
    } else {
      tagFilterToggle.classList.remove("has-active");
    }
    tagNames.forEach(function (tag) {
      var pill = document.createElement("button");
      pill.className = "tag-filter-pill";
      if (selectedFilterTags.indexOf(tag) !== -1) pill.classList.add("active");
      pill.textContent = tag + " (" + tagCounts[tag] + ")";
      pill.addEventListener("click", function () {
        var idx = selectedFilterTags.indexOf(tag);
        if (idx !== -1) {
          selectedFilterTags.splice(idx, 1);
        } else {
          selectedFilterTags.push(tag);
        }
        var prevNoteId = displayCards[currentIndex] ? displayCards[currentIndex].note_id : null;
        applyFilterSort();
        restoreSelection(prevNoteId);
        buildTagFilterBar();
      });
      tagFilterPills.appendChild(pill);
    });
  }

  tagFilterToggle.addEventListener("click", function () {
    tagFilterBar.classList.toggle("expanded");
    tagFilterPills.classList.toggle("hidden");
  });

  // ── Create new card helper ──

  function createNewCard() {
    if (displayCards.length === 0) {
      showToast("No cards to inherit model from");
      return;
    }
    var selectedCard = displayCards[currentIndex >= 0 ? currentIndex : 0];
    var modelId = selectedCard.model_id;

    // Find position in master cards array — insert after current card
    var masterIndex = cards.indexOf(selectedCard);
    var insertPosition = masterIndex >= 0 ? masterIndex + 1 : cards.length;

    pywebview.api.create_card(modelId, insertPosition)
      .then(function (res) {
        if (!res.ok) {
          showToast("Create failed: " + res.error);
          return;
        }
        // Insert new card at the correct position in master array
        cards.splice(insertPosition, 0, res.card);
        // Inherit tags from the card we were on
        if (selectedCard.tags && selectedCard.tags.length > 0) {
          res.card.tags = selectedCard.tags.slice();
          persistTags(res.card);
        }
        // Re-apply filter/sort and select the new card
        applyFilterSort();
        restoreSelection(res.card.note_id);
        showToast("Card created");
      });
  }

  function buildSidebar() {
    cardList.innerHTML = "";
    if (displayCards.length === 0) {
      var empty = document.createElement("div");
      empty.className = "card-list-empty";
      empty.textContent = "No cards match";
      cardList.appendChild(empty);
      return;
    }
    var tagsSorting = sortOrder.value === "tags";
    var currentGroupLabel = null;
    displayCards.forEach(function (card, i) {
      // Insert group header when sorting by tags
      if (tagsSorting) {
        var groupLabel = (card.tags && card.tags.length)
          ? card.tags.slice().sort().join(", ")
          : "Untagged";
        if (groupLabel !== currentGroupLabel) {
          currentGroupLabel = groupLabel;
          var header = document.createElement("div");
          header.className = "card-group-header";
          header.textContent = groupLabel;
          cardList.appendChild(header);
        }
      }

      const fieldNames = Object.keys(card.fields);
      const front = card.fields[fieldNames[0]] || "";
      const frontText = stripHtml(front).trim().substring(0, 80) || "(empty)";
      const sub = fieldNames.length > 1
        ? stripHtml(card.fields[fieldNames[1]] || "").trim().substring(0, 60)
        : "";

      const item = document.createElement("div");
      item.className = "card-item";
      item.innerHTML =
        '<span class="card-item-num">' + (i + 1) + '</span>' +
        '<div class="card-item-body">' +
        '<div class="card-item-title">' + escapeHtml(frontText) + '</div>' +
        (sub ? '<div class="card-item-sub">' + escapeHtml(sub) + '</div>' : "") +
        '</div>';
      item.addEventListener("click", function () { showCard(i); });
      cardList.appendChild(item);
    });
  }

  // ── Filter/sort event listeners ──

  filterImages.addEventListener("change", function () {
    var prevNoteId = displayCards[currentIndex] ? displayCards[currentIndex].note_id : null;
    applyFilterSort();
    restoreSelection(prevNoteId);
  });

  sortOrder.addEventListener("change", function () {
    var prevNoteId = displayCards[currentIndex] ? displayCards[currentIndex].note_id : null;
    applyFilterSort();
    restoreSelection(prevNoteId);
  });

  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var prevNoteId = displayCards[currentIndex] ? displayCards[currentIndex].note_id : null;
      applyFilterSort();
      restoreSelection(prevNoteId);
    }, 150);
  });

  // ── Image paste handler ──

  document.addEventListener("paste", function (e) {
    if (viewer.classList.contains("hidden")) return;
    if (currentIndex < 0) return;

    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    var imageItem = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image/") === 0) {
        imageItem = items[i];
        break;
      }
    }

    // No image in clipboard — force plain-text paste in editable fields
    if (!imageItem) {
      var target = e.target.closest && e.target.closest('.field-value');
      if (target) {
        e.preventDefault();
        var text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }
      return;
    }

    // Determine target field: the focused editing field, or the selected field
    var targetField = editingField || selectedFieldName;
    if (!targetField) return;

    e.preventDefault();
    var blob = imageItem.getAsFile();
    var mimeType = imageItem.type;
    var reader = new FileReader();
    reader.onload = function () {
      // result is "data:<mime>;base64,<data>"
      var base64Data = reader.result.split(",")[1];
      var card = displayCards[currentIndex];
      pywebview.api.paste_image(card.note_id, targetField, base64Data, mimeType)
        .then(function (res) {
          if (!res.ok) {
            showToast("Paste failed: " + res.error);
            return;
          }
          // Append image to display and in-memory card data
          var imgHtml = '<img src="' + res.data_uri + '">';
          card.fields[targetField] += imgHtml;
          var fieldEl = document.querySelector('.field-value[data-field-name="' + targetField + '"]');
          if (fieldEl) {
            // Remove (empty) placeholder if present
            var emptySpan = fieldEl.querySelector('span[style]');
            if (emptySpan && emptySpan.textContent === "(empty)") {
              emptySpan.remove();
            }
            var img = document.createElement("img");
            img.src = res.data_uri;
            fieldEl.appendChild(img);
            layoutImages(fieldEl);
          }
          showToast("Image pasted");
          // Re-apply filter if active (card may now match/unmatch image filter)
          if (filterImages.value !== "all") {
            var prevNoteId = card.note_id;
            applyFilterSort();
            restoreSelection(prevNoteId);
          }
        });
    };
    reader.readAsDataURL(blob);
  });

  // ── Upload handler ──

  function handleUpload(fieldName) {
    if (currentIndex < 0) return;
    var card = displayCards[currentIndex];
    pywebview.api.upload_image(card.note_id, fieldName)
      .then(function (res) {
        if (!res.ok) {
          if (res.error !== "cancelled") showToast("Upload failed: " + res.error);
          return;
        }
        var imgHtml = '<img src="' + res.data_uri + '">';
        card.fields[fieldName] += imgHtml;
        var fieldEl = document.querySelector('.field-value[data-field-name="' + fieldName + '"]');
        if (fieldEl) {
          var emptySpan = fieldEl.querySelector('span[style]');
          if (emptySpan && emptySpan.textContent === "(empty)") {
            emptySpan.remove();
          }
          var img = document.createElement("img");
          img.src = res.data_uri;
          fieldEl.appendChild(img);
          layoutImages(fieldEl);
        }
        showToast("Image added");
        // Re-apply filter if active
        if (filterImages.value !== "all") {
          var prevNoteId = card.note_id;
          applyFilterSort();
          restoreSelection(prevNoteId);
        }
      });
  }

  // ── Remove image handler ──

  function handleRemoveImage() {
    if (!selectedImg || currentIndex < 0) return;
    var fieldEl = selectedImg.closest(".field-value");
    if (!fieldEl) return;
    var fieldName = fieldEl.dataset.fieldName;
    var imgs = fieldEl.querySelectorAll("img");
    var imageIndex = Array.prototype.indexOf.call(imgs, selectedImg);
    if (imageIndex < 0) return;

    var card = displayCards[currentIndex];
    var imgToRemove = selectedImg;
    clearImgSelection();

    pywebview.api.remove_image(card.note_id, fieldName, imageIndex)
      .then(function (res) {
        if (!res.ok) {
          showToast("Remove failed: " + res.error);
          return;
        }
        imgToRemove.remove();
        layoutImages(fieldEl);
        // Update in-memory card field: strip the Nth <img> tag
        var tmp = document.createElement("div");
        tmp.innerHTML = card.fields[fieldName];
        var memImgs = tmp.querySelectorAll("img");
        if (memImgs[imageIndex]) memImgs[imageIndex].remove();
        card.fields[fieldName] = tmp.innerHTML;
        showToast("Image removed");
        // Re-apply filter if active
        if (filterImages.value !== "all") {
          var prevNoteId = card.note_id;
          applyFilterSort();
          restoreSelection(prevNoteId);
        }
      });
  }

  // ── Save handlers ──

  btnSave.addEventListener("click", function () {
    pywebview.api.save_deck()
      .then(function (res) {
        if (!res.ok) {
          if (res.error !== "cancelled") showToast("Save failed: " + res.error);
          return;
        }
        showToast("Deck saved");
      });
  });

  btnSaveDropdown.addEventListener("click", function (e) {
    e.stopPropagation();
    saveDropdown.classList.toggle("hidden");
  });

  document.getElementById("save-overwrite").addEventListener("click", function () {
    saveDropdown.classList.add("hidden");
    pywebview.api.save_deck_as_overwrite()
      .then(function (res) {
        if (!res) return;
        if (!res.ok) {
          showToast("Save failed: " + res.error);
          return;
        }
        showToast("Deck saved (overwritten)");
      });
  });

  document.getElementById("save-copy").addEventListener("click", function () {
    saveDropdown.classList.add("hidden");
    pywebview.api.save_deck_as()
      .then(function (res) {
        if (!res.ok) {
          if (res.error !== "cancelled") showToast("Save failed: " + res.error);
          return;
        }
        showToast("Deck saved as copy");
      });
  });

  // Close dropdowns and context menu when clicking outside
  document.addEventListener("click", function () {
    saveDropdown.classList.add("hidden");
    recentDropdown.classList.add("hidden");
    contextMenu.classList.add("hidden");
  });

  // ── Recent files handlers ──

  async function loadRecentFiles() {
    try {
      const recent = await pywebview.api.get_recent_files();
      if (recent.length === 0) {
        btnRecent.disabled = true;
        recentList.innerHTML = "";
        return;
      }

      btnRecent.disabled = false;
      recentList.innerHTML = recent.map(function (r) {
        return '<button class="recent-item" data-path="' + escapeHtml(r.path) + '" title="' + escapeHtml(r.path) + '">' +
          escapeHtml(r.name) +
          '</button>';
      }).join("");

      // Bind click and context menu handlers to recent items
      recentList.querySelectorAll(".recent-item").forEach(function (item) {
        item.addEventListener("click", function (e) {
          e.stopPropagation();
          recentDropdown.classList.add("hidden");
          loadDeck(item.dataset.path);
        });
        item.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
          contextMenuPath = item.dataset.path;
          contextMenu.style.left = e.clientX + "px";
          contextMenu.style.top = e.clientY + "px";
          contextMenu.classList.remove("hidden");
        });
      });
    } catch (e) {
      btnRecent.disabled = true;
    }
  }

  btnRecent.addEventListener("click", function (e) {
    e.stopPropagation();
    recentDropdown.classList.toggle("hidden");
  });

  btnClearRecent.addEventListener("click", function (e) {
    e.stopPropagation();
    pywebview.api.clear_recent_files().then(function () {
      recentDropdown.classList.add("hidden");
      loadRecentFiles();
      showToast("Recent files cleared");
    });
  });

  // Context menu: Show in Finder
  ctxShowInFinder.addEventListener("click", function (e) {
    e.stopPropagation();
    contextMenu.classList.add("hidden");
    if (contextMenuPath) {
      pywebview.api.reveal_in_finder(contextMenuPath);
      contextMenuPath = null;
    }
  });

  // ── Settings handlers ──

  const quitOnSaveCheckbox = document.getElementById("quit-on-save");

  btnSettings.addEventListener("click", function () {
    pywebview.api.get_settings()
      .then(function (settings) {
        var radios = document.querySelectorAll('input[name="save_mode"]');
        radios.forEach(function (r) {
          r.checked = r.value === (settings.save_mode || "copy");
        });
        quitOnSaveCheckbox.checked = settings.quit_on_save || false;
        settingsOverlay.classList.remove("hidden");
      });
  });

  btnSettingsDone.addEventListener("click", function () {
    var selected = document.querySelector('input[name="save_mode"]:checked');
    var mode = selected ? selected.value : "copy";
    var quitOnSave = quitOnSaveCheckbox.checked;
    pywebview.api.update_settings({ save_mode: mode, quit_on_save: quitOnSave })
      .then(function () {
        settingsOverlay.classList.add("hidden");
        showToast("Settings saved");
      });
  });

  // ── Preview toggle handlers ──

  btnEditor.addEventListener("click", function () {
    if (!previewMode) return;
    previewMode = false;
    btnEditor.classList.add("active");
    btnPreview.classList.remove("active");
    cardFields.classList.remove("hidden");
    cardPreview.classList.add("hidden");
    if (currentIndex >= 0) showCard(currentIndex);
  });

  btnPreview.addEventListener("click", function () {
    if (previewMode) return;
    previewMode = true;
    btnPreview.classList.add("active");
    btnEditor.classList.remove("active");
    cardPreview.classList.remove("hidden");
    cardFields.classList.add("hidden");
    previewShowingBack = false;
    if (currentIndex >= 0) showPreview(currentIndex);
  });

  btnFlip.addEventListener("click", function () {
    previewShowingBack = !previewShowingBack;
    if (currentIndex >= 0) showPreview(currentIndex);
  });

  // ── Create card handler ──

  btnAddCard.addEventListener("click", function () {
    createNewCard();
  });

  // ── Delete card handlers ──

  btnDeleteCard.addEventListener("click", function () {
    if (currentIndex < 0 || displayCards.length === 0) return;
    deleteConfirmOverlay.classList.remove("hidden");
  });

  btnDeleteCancel.addEventListener("click", function () {
    deleteConfirmOverlay.classList.add("hidden");
  });

  btnDeleteConfirm.addEventListener("click", function () {
    deleteConfirmOverlay.classList.add("hidden");
    if (currentIndex < 0 || displayCards.length === 0) return;

    var card = displayCards[currentIndex];
    var noteId = card.note_id;

    pywebview.api.delete_card(noteId)
      .then(function (res) {
        if (!res.ok) {
          showToast("Delete failed: " + res.error);
          return;
        }
        // Remove from cards array
        var cardIdx = cards.findIndex(function (c) { return c.note_id === noteId; });
        if (cardIdx >= 0) cards.splice(cardIdx, 1);

        // Determine next card to select
        var nextNoteId = null;
        if (displayCards.length > 1) {
          if (currentIndex < displayCards.length - 1) {
            nextNoteId = displayCards[currentIndex + 1].note_id;
          } else if (currentIndex > 0) {
            nextNoteId = displayCards[currentIndex - 1].note_id;
          }
        }

        applyFilterSort();
        restoreSelection(nextNoteId);
        showToast("Card deleted");
      });
  });

  // ── Deck loading ──

  async function createNewDeck(deckName) {
    loading.classList.remove("hidden");
    try {
      const result = await pywebview.api.create_new_deck(deckName);
      if (!result.ok) {
        alert("Error creating deck: " + result.error);
        return;
      }
      cards = result.cards;
      models = result.models || {};

      searchInput.value = "";
      filterImages.value = "all";
      sortOrder.value = "original";
      selectedFilterTags = [];
      displayCards = cards.slice();

      deckTitle.textContent = cards.length + " cards";
      buildSidebar();
      buildTagFilterBar();

      dropZone.classList.add("hidden");
      viewer.classList.remove("hidden");
      showCard(0);
    } catch (e) {
      alert("Failed to create deck: " + e);
    } finally {
      loading.classList.add("hidden");
    }
  }

  async function loadDeck(path) {
    loading.classList.remove("hidden");
    try {
      const result = await pywebview.api.load_apkg(path);
      if (!result.ok) {
        alert("Error loading deck: " + result.error);
        return;
      }
      cards = result.cards;
      models = result.models || {};
      if (cards.length === 0) {
        alert("No cards found in this deck.");
        return;
      }

      // Reset filter/sort/search to defaults
      searchInput.value = "";
      filterImages.value = "all";
      sortOrder.value = "original";
      selectedFilterTags = [];
      displayCards = cards.slice();

      deckTitle.textContent = cards.length + " cards";
      buildSidebar();
      buildTagFilterBar();

      dropZone.classList.add("hidden");
      viewer.classList.remove("hidden");
      showCard(0);
    } catch (e) {
      alert("Failed to load deck: " + e);
    } finally {
      loading.classList.add("hidden");
    }
  }

  function resetToDropZone() {
    pywebview.api.close_session();
    cards = [];
    displayCards = [];
    models = {};
    currentIndex = -1;
    selectedFieldName = null;
    editingField = null;
    previewMode = false;
    previewShowingBack = false;
    selectedFilterTags = [];
    btnEditor.classList.add("active");
    btnPreview.classList.remove("active");
    cardFields.classList.remove("hidden");
    cardPreview.classList.add("hidden");
    cardList.innerHTML = "";
    cardFields.innerHTML = "";
    viewer.classList.add("hidden");
    dropZone.classList.remove("hidden");
    loadRecentFiles();  // Refresh recent files list
  }

  // ── Text file import ──

  window._loadTextFromPath = async function (path) {
    try {
      const result = await pywebview.api.parse_text_file(path);
      if (!result.ok) {
        alert("Error parsing file: " + result.error);
        return;
      }
      pendingImportPath = path;

      // Build info line
      var delimNames = {tab: "tab-separated", semicolon: "semicolon-separated", comma: "comma-separated"};
      var info = "Found " + result.rows.length + " cards (" + (delimNames[result.delimiter] || result.delimiter) + ")";
      if (result.has_header && result.header_row) {
        info += "<br>Header detected: " + result.header_row.map(escapeHtml).join(", ");
      }
      importInfo.innerHTML = info;

      // Build sample table (first 5 rows)
      var sampleRows = result.rows.slice(0, 5);
      var numCols = result.num_fields;
      var tableHtml = "<table><thead><tr>";
      for (var c = 0; c < numCols; c++) {
        var header = (result.has_header && result.header_row && result.header_row[c])
          ? escapeHtml(result.header_row[c])
          : "Field " + (c + 1);
        tableHtml += "<th>" + header + "</th>";
      }
      tableHtml += "</tr></thead><tbody>";
      sampleRows.forEach(function (row) {
        tableHtml += "<tr>";
        for (var c = 0; c < numCols; c++) {
          tableHtml += "<td>" + escapeHtml(row[c] || "") + "</td>";
        }
        tableHtml += "</tr>";
      });
      if (result.rows.length > 5) {
        tableHtml += '<tr><td colspan="' + numCols + '" style="text-align:center;color:var(--text-secondary);font-style:italic;">... and ' + (result.rows.length - 5) + ' more</td></tr>';
      }
      tableHtml += "</tbody></table>";
      importSample.innerHTML = tableHtml;

      // Show/hide import target radios
      if (!viewer.classList.contains("hidden") && cards.length > 0) {
        importTarget.classList.remove("hidden");
      } else {
        importTarget.classList.add("hidden");
      }

      importPreviewOverlay.classList.remove("hidden");
    } catch (e) {
      alert("Failed to parse text file: " + e);
    }
  };

  async function confirmImport() {
    var mode = "new";
    if (!importTarget.classList.contains("hidden")) {
      var checked = document.querySelector('input[name="import_mode"]:checked');
      if (checked) mode = checked.value;
    }

    importPreviewOverlay.classList.add("hidden");
    loading.classList.remove("hidden");

    try {
      var result = await pywebview.api.import_text_cards(pendingImportPath, mode);
      if (!result.ok) {
        showToast("Import failed: " + result.error);
        return;
      }
      cards = result.cards;
      models = result.models || {};

      // Reset filter/sort/search
      searchInput.value = "";
      filterImages.value = "all";
      sortOrder.value = "original";
      selectedFilterTags = [];
      displayCards = cards.slice();

      deckTitle.textContent = cards.length + " cards";
      buildSidebar();
      buildTagFilterBar();

      dropZone.classList.add("hidden");
      viewer.classList.remove("hidden");
      if (cards.length > 0) showCard(0);
      showToast("Imported " + cards.length + " cards");
    } catch (e) {
      alert("Import failed: " + e);
    } finally {
      loading.classList.add("hidden");
      pendingImportPath = null;
    }
  }

  btnImportCancel.addEventListener("click", function () {
    importPreviewOverlay.classList.add("hidden");
    pendingImportPath = null;
  });

  btnImportConfirm.addEventListener("click", confirmImport);

  // ── Drag and drop ──

  window._loadDeckFromPath = function (path) {
    loadDeck(path);
  };

  document.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (viewer.classList.contains("hidden")) {
      dropZone.classList.add("drag-over");
    }
  });

  document.addEventListener("dragleave", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.relatedTarget === null || !document.contains(e.relatedTarget)) {
      dropZone.classList.remove("drag-over");
    }
  });

  document.addEventListener("drop", function (e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
  });

  // ── File dialog ──

  btnOpen.addEventListener("click", async function () {
    try {
      const path = await pywebview.api.open_file_dialog();
      if (path) {
        if (path.toLowerCase().endsWith(".txt") || path.toLowerCase().endsWith(".csv")) {
          window._loadTextFromPath(path);
        } else {
          loadDeck(path);
        }
      }
    } catch (e) {
      alert("Failed to open file dialog: " + e);
    }
  });

  // ── Back button ──

  btnBack.addEventListener("click", resetToDropZone);

  // ── Create new deck handlers ──

  btnCreate.addEventListener("click", function () {
    createDeckName.value = "";
    createDeckOverlay.classList.remove("hidden");
    createDeckName.focus();
  });

  btnCreateCancel.addEventListener("click", function () {
    createDeckOverlay.classList.add("hidden");
  });

  btnCreateConfirm.addEventListener("click", function () {
    var name = createDeckName.value.trim();
    if (!name) return;
    createDeckOverlay.classList.add("hidden");
    createNewDeck(name);
  });

  createDeckName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      btnCreateConfirm.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      createDeckOverlay.classList.add("hidden");
    }
  });

  // ── Tags input handlers ──

  tagsInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      var tag = tagsInput.value.trim();
      if (!tag || currentIndex < 0) return;
      var card = displayCards[currentIndex];
      if (!card.tags) card.tags = [];
      if (card.tags.indexOf(tag) === -1) {
        card.tags.push(tag);
        renderTags(card);
        persistTags(card);
      }
      tagsInput.value = "";
    } else if (e.key === "Escape") {
      e.preventDefault();
      tagsInput.blur();
    }
  });

  tagsInput.addEventListener("focus", function () {
    editingField = "__tags__";
  });

  tagsInput.addEventListener("blur", function () {
    if (editingField === "__tags__") editingField = null;
  });

  // ── Keyboard navigation ──

  document.addEventListener("keydown", function (e) {
    // Handle Escape for create deck dialog
    if (!createDeckOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") {
        createDeckOverlay.classList.add("hidden");
      }
      return;
    }

    // Handle Escape for import preview dialog
    if (!importPreviewOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") {
        importPreviewOverlay.classList.add("hidden");
        pendingImportPath = null;
      }
      return;
    }

    // Handle Escape for delete confirmation dialog
    if (!deleteConfirmOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") {
        deleteConfirmOverlay.classList.add("hidden");
      }
      return;
    }

    if (viewer.classList.contains("hidden")) return;

    // Cmd+N: create new card (works even while editing)
    if ((e.metaKey || e.ctrlKey) && e.key === "n") {
      e.preventDefault();
      createNewCard();
      return;
    }

    // When editing a field, only handle Escape
    if (editingField) {
      if (e.key === "Escape") {
        document.activeElement.blur();
      }
      return;
    }

    // Spacebar flips front/back in preview mode
    if (previewMode && e.key === " ") {
      e.preventDefault();
      previewShowingBack = !previewShowingBack;
      if (currentIndex >= 0) showPreview(currentIndex);
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      if (currentIndex > 0) showCard(currentIndex - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      if (currentIndex < displayCards.length - 1) showCard(currentIndex + 1);
    } else if ((e.key === "Backspace" || e.key === "Delete") && selectedImg) {
      e.preventDefault();
      handleRemoveImage();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedImg) {
      e.preventDefault();
      var src = selectedImg.src;
      if (src && src.startsWith("data:")) {
        pywebview.api.copy_image(src).then(function (res) {
          if (res.ok) showToast("Image copied");
          else showToast("Copy failed: " + res.error);
        });
      }
    }
  });

  // ── Initialization ──

  // Load recent files on startup (wait for pywebview to be ready)
  window.addEventListener("pywebviewready", function () {
    loadRecentFiles();
  });
})();
