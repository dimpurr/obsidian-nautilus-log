var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/blockconfig.ts
var blockconfig_exports = {};
__export(blockconfig_exports, {
  applyOverrides: () => applyOverrides,
  extractPlanBody: () => extractPlanBody,
  parseBlockConfig: () => parseBlockConfig
});
module.exports = __toCommonJS(blockconfig_exports);
var BLANK_RE = /^\s*$/;
function parseHour(raw) {
  const t = raw.trim();
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m)
    return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h < 0 || h > 24)
    return null;
  return h;
}
function parseInt_(raw) {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}
function parseBlockConfig(source) {
  const out = { unknown: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#"))
      continue;
    const idx = line.indexOf(":");
    if (idx < 0) {
      out.unknown.push({ key: line, value: "" });
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case "start":
      case "start-time":
      case "workday-start": {
        const h = parseHour(value);
        if (h !== null)
          out.workdayStartHour = h;
        else
          out.unknown.push({ key, value });
        break;
      }
      case "end":
      case "end-time":
      case "workday-end": {
        const h = parseHour(value);
        if (h !== null)
          out.workdayEndHour = h;
        else
          out.unknown.push({ key, value });
        break;
      }
      case "default-duration":
      case "todo-duration": {
        const n = parseInt_(value);
        if (n !== null)
          out.todoDuration = n;
        else
          out.unknown.push({ key, value });
        break;
      }
      case "legend-length":
      case "desc-length": {
        const n = parseInt_(value);
        if (n !== null)
          out.descLength = n;
        else
          out.unknown.push({ key, value });
        break;
      }
      case "urgent":
      case "urgent-trigger":
        out.urgentTrigger = value;
        break;
      case "language":
      case "lang":
        if (value === "en" || value === "zh")
          out.language = value;
        else
          out.unknown.push({ key, value });
        break;
      default:
        out.unknown.push({ key, value });
    }
  }
  return out;
}
function applyOverrides(base, o) {
  return {
    ...base,
    ...o.workdayStartHour !== void 0 ? { workdayStartHour: o.workdayStartHour } : {},
    ...o.workdayEndHour !== void 0 ? { workdayEndHour: o.workdayEndHour } : {},
    ...o.todoDuration !== void 0 ? { todoDuration: o.todoDuration } : {},
    ...o.descLength !== void 0 ? { descLength: o.descLength } : {},
    ...o.urgentTrigger !== void 0 ? { urgentTrigger: o.urgentTrigger } : {},
    ...o.language !== void 0 ? { language: o.language } : {}
  };
}
function extractPlanBody(fileText, blockLineEnd) {
  const lines = fileText.split(/\r?\n/);
  let i = blockLineEnd + 1;
  while (i < lines.length && BLANK_RE.test(lines[i]))
    i += 1;
  const startLine = i;
  const collected = [];
  while (i < lines.length && !BLANK_RE.test(lines[i])) {
    collected.push(lines[i]);
    i += 1;
  }
  return { body: collected.join("\n"), startLine };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyOverrides,
  extractPlanBody,
  parseBlockConfig
});
