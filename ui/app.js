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
  const filterImages = document.getElementById("filter-images");
  const sortOrder = document.getElementById("sort-order");
  const btnAddCard = document.getElementById("btn-add-card");
  const btnDeleteCard = document.getElementById("btn-delete-card");
  const deleteConfirmOverlay = document.getElementById("delete-confirm-overlay");
  const btnDeleteCancel = document.getElementById("btn-delete-cancel");
  const btnDeleteConfirm = document.getElementById("btn-delete-confirm");

  let cards = [];
  let displayCards = [];
  let currentIndex = -1;
  let selectedFieldName = null;
  let selectedImg = null;
  let editingField = null;

  // ── Filter & sort helpers ──

  function cardHasImages(card) {
    var fields = card.fields;
    for (var key in fields) {
      if (fields[key] && fields[key].indexOf("<img") !== -1) return true;
    }
    return false;
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

    // Sort
    if (sort === "created-desc") {
      filtered.sort(function (a, b) { return b.created_ts - a.created_ts; });
    } else if (sort === "created-asc") {
      filtered.sort(function (a, b) { return a.created_ts - b.created_ts; });
    } else if (sort === "modified-desc") {
      filtered.sort(function (a, b) { return b.mod_ts - a.mod_ts; });
    } else if (sort === "modified-asc") {
      filtered.sort(function (a, b) { return a.mod_ts - b.mod_ts; });
    }
    // "original" keeps the array order from cards.slice() or filtered

    displayCards = filtered;

    // Update title
    if (filter !== "all") {
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
    var newHtml = el.innerHTML;
    var oldHtml = card.fields[fieldName];
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
        '<div class="card-item-title">' + escapeHtml(frontText) + '</div>' +
        (sub ? '<div class="card-item-sub">' + escapeHtml(sub) + '</div>' : "");
    }
  }

  // ── Card display ──

  function showCard(index) {
    if (index < 0 || index >= displayCards.length) return;
    currentIndex = index;

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

  function buildSidebar() {
    cardList.innerHTML = "";
    if (displayCards.length === 0) {
      var empty = document.createElement("div");
      empty.className = "card-list-empty";
      empty.textContent = "No cards match";
      cardList.appendChild(empty);
      return;
    }
    displayCards.forEach(function (card, i) {
      const fieldNames = Object.keys(card.fields);
      const front = card.fields[fieldNames[0]] || "";
      const frontText = stripHtml(front).trim().substring(0, 80) || "(empty)";
      const sub = fieldNames.length > 1
        ? stripHtml(card.fields[fieldNames[1]] || "").trim().substring(0, 60)
        : "";

      const item = document.createElement("div");
      item.className = "card-item";
      item.innerHTML =
        '<div class="card-item-title">' + escapeHtml(frontText) + '</div>' +
        (sub ? '<div class="card-item-sub">' + escapeHtml(sub) + '</div>' : "");
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

    // No image in clipboard — let normal text paste work if editing
    if (!imageItem) return;

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

  // Close dropdown when clicking outside
  document.addEventListener("click", function () {
    saveDropdown.classList.add("hidden");
    recentDropdown.classList.add("hidden");
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

      // Bind click handlers to recent items
      recentList.querySelectorAll(".recent-item").forEach(function (item) {
        item.addEventListener("click", function (e) {
          e.stopPropagation();
          recentDropdown.classList.add("hidden");
          loadDeck(item.dataset.path);
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

  // ── Create card handler ──

  btnAddCard.addEventListener("click", function () {
    if (displayCards.length === 0) {
      showToast("No cards to inherit model from");
      return;
    }
    var modelId = displayCards[currentIndex >= 0 ? currentIndex : 0].model_id;
    pywebview.api.create_card(modelId)
      .then(function (res) {
        if (!res.ok) {
          showToast("Create failed: " + res.error);
          return;
        }
        // Add new card to cards array
        cards.push(res.card);
        // Re-apply filter/sort and select the new card
        applyFilterSort();
        restoreSelection(res.card.note_id);
        showToast("Card created");
      });
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

  async function loadDeck(path) {
    loading.classList.remove("hidden");
    try {
      const result = await pywebview.api.load_apkg(path);
      if (!result.ok) {
        alert("Error loading deck: " + result.error);
        return;
      }
      cards = result.cards;
      if (cards.length === 0) {
        alert("No cards found in this deck.");
        return;
      }

      // Reset filter/sort to defaults
      filterImages.value = "all";
      sortOrder.value = "original";
      displayCards = cards.slice();

      deckTitle.textContent = cards.length + " cards";
      buildSidebar();

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
    currentIndex = -1;
    selectedFieldName = null;
    editingField = null;
    cardList.innerHTML = "";
    cardFields.innerHTML = "";
    viewer.classList.add("hidden");
    dropZone.classList.remove("hidden");
    loadRecentFiles();  // Refresh recent files list
  }

  // ── Drag and drop ──

  window._loadDeckFromPath = function (path) {
    loadDeck(path);
  };

  document.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!viewer.classList.contains("hidden")) return;
    dropZone.classList.add("drag-over");
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
        loadDeck(path);
      }
    } catch (e) {
      alert("Failed to open file dialog: " + e);
    }
  });

  // ── Back button ──

  btnBack.addEventListener("click", resetToDropZone);

  // ── Keyboard navigation ──

  document.addEventListener("keydown", function (e) {
    // Handle Escape for delete confirmation dialog
    if (!deleteConfirmOverlay.classList.contains("hidden")) {
      if (e.key === "Escape") {
        deleteConfirmOverlay.classList.add("hidden");
      }
      return;
    }

    if (viewer.classList.contains("hidden")) return;

    // When editing a field, only handle Escape
    if (editingField) {
      if (e.key === "Escape") {
        document.activeElement.blur();
      }
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
