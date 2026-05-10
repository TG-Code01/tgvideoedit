const state = {
  reference: null,
  source: null,
  profileUrl: null,
};

const $ = (id) => document.getElementById(id);

const elements = {
  referenceInput: $("referenceInput"),
  sourceInput: $("sourceInput"),
  referenceDrop: $("referenceDrop"),
  sourceDrop: $("sourceDrop"),
  referencePreview: $("referencePreview"),
  sourcePreview: $("sourcePreview"),
  outputPreview: $("outputPreview"),
  referenceCard: $("referencePreviewCard"),
  sourceCard: $("sourcePreviewCard"),
  outputPlayer: document.querySelector(".output-player"),
  referenceName: $("referenceName"),
  sourceName: $("sourceName"),
  referenceMeta: $("referenceMeta"),
  sourceMeta: $("sourceMeta"),
  generateButton: $("generateButton"),
  renderNote: $("renderNote"),
  saveState: $("saveState"),
  analysisStatus: $("analysisStatus"),
  cutsMetric: $("cutsMetric"),
  pacingMetric: $("pacingMetric"),
  presetMetric: $("presetMetric"),
  audioMetric: $("audioMetric"),
  matchMetric: $("matchMetric"),
  timeline: $("timeline"),
  profileLink: $("profileLink"),
  previewState: $("previewState"),
};

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function loadVideoMeta(video, file, metaElement) {
  const url = URL.createObjectURL(file);
  video.src = url;
  video.onloadedmetadata = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const mins = Math.floor(duration / 60);
    const secs = Math.round(duration % 60).toString().padStart(2, "0");
    metaElement.textContent = `${mins}:${secs} · ${formatBytes(file.size)}`;
  };
}

function setFile(kind, file) {
  if (!file) return;
  state[kind] = file;
  const preview = kind === "reference" ? elements.referencePreview : elements.sourcePreview;
  const card = kind === "reference" ? elements.referenceCard : elements.sourceCard;
  const name = kind === "reference" ? elements.referenceName : elements.sourceName;
  const meta = kind === "reference" ? elements.referenceMeta : elements.sourceMeta;
  name.textContent = file.name;
  card.classList.add("has-video");
  loadVideoMeta(preview, file, meta);
  elements.saveState.textContent = state.reference && state.source ? "Ready to generate" : "One more clip needed";
}

function clearFile(kind) {
  state[kind] = null;
  const preview = kind === "reference" ? elements.referencePreview : elements.sourcePreview;
  const card = kind === "reference" ? elements.referenceCard : elements.sourceCard;
  const name = kind === "reference" ? elements.referenceName : elements.sourceName;
  const meta = kind === "reference" ? elements.referenceMeta : elements.sourceMeta;
  preview.removeAttribute("src");
  preview.load();
  card.classList.remove("has-video");
  name.textContent = kind === "reference" ? "No reference selected" : "No source selected";
  meta.textContent = "MP4, MOV, AVI";
  elements.saveState.textContent = "Ready to upload clips";
}

function wireDropZone(kind, dropZone, input) {
  input.addEventListener("change", () => setFile(kind, input.files[0]));
  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });
  dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files[0];
    setFile(kind, file);
  });
}

function buildTimeline(profile) {
  const segments = profile.segments || [];
  const flashes = profile.flash_times || [];
  const total = segments.reduce((sum, value) => sum + value, 0) || 1;

  elements.timeline.innerHTML = "";
  if (!segments.length) {
    elements.timeline.innerHTML = '<div class="timeline-empty">No timeline data returned.</div>';
    return;
  }

  let cursor = 0;
  for (const duration of segments) {
    const segment = document.createElement("div");
    segment.className = "segment";
    segment.style.flex = `${Math.max(0.18, duration / total)} 1 0`;
    segment.dataset.time = cursor.toFixed(1);
    if (flashes.some((time) => time >= cursor && time < cursor + duration)) {
      segment.classList.add("flash");
    }
    elements.timeline.appendChild(segment);
    cursor += duration;
  }
}

function updateMetrics(profile) {
  const segments = profile.segments || [];
  const cuts = Math.max(0, segments.length - 1);
  const avg = segments.length ? segments.reduce((sum, value) => sum + value, 0) / segments.length : 0;
  const preset = profile.effect_preset || "auto";
  const matches = profile.matching?.matches?.length || 0;

  elements.cutsMetric.textContent = cuts || "--";
  elements.pacingMetric.textContent = avg ? `${avg.toFixed(1)}s` : "--";
  elements.presetMetric.textContent = preset;
  elements.audioMetric.textContent = profile.audio === "source" ? "Source" : profile.audio === "none" ? "None" : "Ref audio";
  elements.matchMetric.textContent = matches ? `${matches}` : profile.source_mode || "match";
  elements.analysisStatus.textContent = "Analysed and rendered";
  elements.profileLink.disabled = !state.profileUrl;
  buildTimeline(profile);
}

async function generate() {
  if (!state.reference || !state.source) {
    elements.renderNote.textContent = "Upload both a reference video and a new clip first.";
    return;
  }

  const form = new FormData();
  form.append("reference", state.reference);
  form.append("source", state.source);
  form.append("sourceMode", $("sourceMode").value);
  form.append("audio", $("audioSelect").value);
  form.append("effectPreset", $("effectPreset").value);
  form.append("transition", $("transitionSelect").value);
  form.append("copyReferenceOutro", $("copyOutro").checked ? "true" : "false");
  form.append("noFlashes", $("noFlashes").checked ? "true" : "false");

  elements.generateButton.disabled = true;
  elements.generateButton.textContent = "Generating matched edit...";
  elements.renderNote.textContent = "Rendering locally. Larger files can take a few minutes.";
  elements.previewState.textContent = "Rendering";
  elements.saveState.textContent = "Rendering in progress";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Render failed");
    }

    state.profileUrl = result.profileUrl;
    elements.outputPreview.src = `${result.outputUrl}?t=${Date.now()}`;
    elements.outputPlayer.classList.add("has-video");
    elements.previewState.textContent = "Matched edit ready";
    elements.renderNote.innerHTML = `Rendered in ${result.elapsed}s · <a class="output-link" href="${result.outputUrl}" target="_blank">Open output</a>`;
    elements.saveState.textContent = "Generated just now";
    updateMetrics(result.profile || {});
  } catch (error) {
    elements.renderNote.textContent = error.message;
    elements.previewState.textContent = "Render failed";
    elements.saveState.textContent = "Check render error";
  } finally {
    elements.generateButton.disabled = false;
    elements.generateButton.innerHTML = '<span class="sparkle" aria-hidden="true"></span>Generate Matched Edit<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';
  }
}

wireDropZone("reference", elements.referenceDrop, elements.referenceInput);
wireDropZone("source", elements.sourceDrop, elements.sourceInput);

document.querySelectorAll("[data-clear]").forEach((button) => {
  button.addEventListener("click", () => clearFile(button.dataset.clear));
});

elements.generateButton.addEventListener("click", generate);
elements.profileLink.addEventListener("click", () => {
  if (state.profileUrl) window.open(state.profileUrl, "_blank");
});
