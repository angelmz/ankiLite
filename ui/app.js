/* ankiLite — Frontend card viewer */

(function () {
  "use strict";

  const dropZone = document.getElementById("drop-zone");
  const viewer = document.getElementById("viewer");
  const loading = document.getElementById("loading");
  const btnOpen = document.getElementById("btn-open");
  const btnBack = document.getElementById("btn-back");
  const btnExport = document.getElementById("btn-export");
  const deckTitle = document.getElementById("deck-title");
  const cardList = document.getElementById("card-list");
  const cardFields = document.getElementById("card-fields");

  let cards = [];
  let currentIndex = -1;
  let selectedFieldName = null;
  let selectedImg = null;

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

  // ── Card display ──

  function showCard(index) {
    if (index < 0 || index >= cards.length) return;
    currentIndex = index;

    const card = cards[index];
    const fieldNames = Object.keys(card.fields);

    let html = "";
    for (const name of fieldNames) {
      html +=
        '<div class="field-block">' +
          '<div class="field-label">' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<button class="btn-upload" data-field="' + escapeHtml(name) + '" title="Add image from file">+img</button>' +
          '</div>' +
          '<div class="field-value" data-field-name="' + escapeHtml(name) + '">' +
            renderContent(card.fields[name]) +
          '</div>' +
        '</div>';
    }
    cardFields.innerHTML = html;

    // Bind field click for selection
    document.querySelectorAll(".field-value").forEach(function (el) {
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

    // Bind image click for selection
    document.querySelectorAll(".field-value img").forEach(function (img) {
      img.addEventListener("click", function (e) {
        e.stopPropagation();
        selectImg(img);
      });
    });

    // Clear image selection when switching cards
    clearImgSelection();

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
    cards.forEach(function (card, i) {
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

  // ── Image paste handler ──

  document.addEventListener("paste", function (e) {
    if (viewer.classList.contains("hidden")) return;
    if (currentIndex < 0 || !selectedFieldName) return;

    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    var imageItem = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image/") === 0) {
        imageItem = items[i];
        break;
      }
    }
    if (!imageItem) return;

    e.preventDefault();
    var blob = imageItem.getAsFile();
    var mimeType = imageItem.type;
    var reader = new FileReader();
    reader.onload = function () {
      // result is "data:<mime>;base64,<data>"
      var base64Data = reader.result.split(",")[1];
      var card = cards[currentIndex];
      pywebview.api.paste_image(card.note_id, selectedFieldName, base64Data, mimeType)
        .then(function (res) {
          if (!res.ok) {
            showToast("Paste failed: " + res.error);
            return;
          }
          // Append image to display and in-memory card data
          var imgHtml = '<img src="' + res.data_uri + '">';
          card.fields[selectedFieldName] += imgHtml;
          var fieldEl = document.querySelector('.field-value[data-field-name="' + selectedFieldName + '"]');
          if (fieldEl) {
            // Remove (empty) placeholder if present
            var emptySpan = fieldEl.querySelector('span[style]');
            if (emptySpan && emptySpan.textContent === "(empty)") {
              emptySpan.remove();
            }
            var img = document.createElement("img");
            img.src = res.data_uri;
            img.addEventListener("click", function (ev) {
              ev.stopPropagation();
              selectImg(img);
            });
            fieldEl.appendChild(img);
          }
          showToast("Image pasted");
        });
    };
    reader.readAsDataURL(blob);
  });

  // ── Upload handler ──

  function handleUpload(fieldName) {
    if (currentIndex < 0) return;
    var card = cards[currentIndex];
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
          img.addEventListener("click", function (ev) {
            ev.stopPropagation();
            selectImg(img);
          });
          fieldEl.appendChild(img);
        }
        showToast("Image added");
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

    var card = cards[currentIndex];
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
      });
  }

  // ── Export handler ──

  btnExport.addEventListener("click", function () {
    pywebview.api.export_apkg()
      .then(function (res) {
        if (!res.ok) {
          if (res.error !== "cancelled") showToast("Export failed: " + res.error);
          return;
        }
        showToast("Deck exported successfully");
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
    currentIndex = -1;
    selectedFieldName = null;
    cardList.innerHTML = "";
    cardFields.innerHTML = "";
    viewer.classList.add("hidden");
    dropZone.classList.remove("hidden");
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
    if (viewer.classList.contains("hidden")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      if (currentIndex > 0) showCard(currentIndex - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      if (currentIndex < cards.length - 1) showCard(currentIndex + 1);
    } else if ((e.key === "Backspace" || e.key === "Delete") && selectedImg) {
      e.preventDefault();
      handleRemoveImage();
    }
  });
})();
