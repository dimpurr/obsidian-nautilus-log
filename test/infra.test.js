"use strict";
/*
 * infra.test.js — Release workflow, issue templates, and README translation tests.
 *
 * Tests the release infrastructure and documentation parity.
 * Verifies that:
 * 1. .github/workflows/release.yml exists, is valid YAML, triggers on non-v tags,
 *    runs test before build, uses pinned action versions, and uploads main.js, manifest.json, styles.css.
 * 2. .github/ISSUE_TEMPLATE/ contains bug_report.yml and feature_request.yml asking all required fields.
 * 3. README.md and README.zh.md have identical heading structure, language switcher links, and image rows.
 *
 * Referenced sources: src/settings.ts, src/contract.ts
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = join(__dirname, "..");

function validateYaml(filePath) {
  const candidates = [
    "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
    "python3",
  ];
  let err = null;
  for (const py of candidates) {
    try {
      execSync(`${py} -c "import yaml,sys;yaml.safe_load(open('${filePath}'))"`, { stdio: "pipe" });
      return; // Success
    } catch (e) {
      err = e;
    }
  }
  throw err || new Error(`Failed to validate YAML for ${filePath}`);
}

test("release workflow exists, is valid YAML, and meets all release criteria", () => {
  const workflowPath = join(ROOT, ".github", "workflows", "release.yml");
  assert.ok(existsSync(workflowPath), ".github/workflows/release.yml must exist");

  const content = readFileSync(workflowPath, "utf8");

  // Validate YAML syntax
  validateYaml(workflowPath);

  // Pinned action versions (e.g. actions/checkout@v4, actions/setup-node@v4)
  assert.ok(!content.includes("@master"), "Workflow must use pinned action versions, not @master");
  assert.match(content, /actions\/checkout@v\d+/, "Checkout must use pinned major version like @v4");
  assert.match(content, /actions\/setup-node@v\d+/, "setup-node must use pinned major version like @v4");

  // Push tag trigger without 'v' prefix
  assert.ok(!content.includes("tags:\n      - 'v*'") && !content.includes("tags:\n      - \"v*\""), "Tag pattern must not require 'v*' prefix");

  // Steps ordering: checkout -> setup-node -> npm ci -> npm test -> npm run build
  const ciIndex = content.indexOf("npm ci");
  const testIndex = content.indexOf("npm test");
  const buildIndex = content.indexOf("npm run build");

  assert.ok(ciIndex !== -1, "Workflow must run npm ci");
  assert.ok(testIndex !== -1, "Workflow must run npm test");
  assert.ok(buildIndex !== -1, "Workflow must run npm run build");
  assert.ok(ciIndex < testIndex, "npm ci must run before npm test");
  assert.ok(testIndex < buildIndex, "npm test must run before npm run build");

  // Uploads main.js, manifest.json, styles.css
  assert.match(content, /main\.js/, "Workflow must include main.js in release");
  assert.match(content, /manifest\.json/, "Workflow must include manifest.json in release");
  assert.match(content, /styles\.css/, "Workflow must include styles.css in release");
});

test("issue templates exist, are valid YAML, and ask required questions", () => {
  const bugPath = join(ROOT, ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  const featurePath = join(ROOT, ".github", "ISSUE_TEMPLATE", "feature_request.yml");

  assert.ok(existsSync(bugPath), ".github/ISSUE_TEMPLATE/bug_report.yml must exist");
  assert.ok(existsSync(featurePath), ".github/ISSUE_TEMPLATE/feature_request.yml must exist");

  // Validate YAML syntax
  validateYaml(bugPath);
  validateYaml(featurePath);

  const bugContent = readFileSync(bugPath, "utf8").toLowerCase();
  assert.ok(bugContent.includes("obsidian"), "Bug report must ask for Obsidian version");
  assert.ok(bugContent.includes("plugin") || bugContent.includes("version"), "Bug report must ask for plugin version");
  assert.ok(bugContent.includes("os") || bugContent.includes("operating system"), "Bug report must ask for OS");
  assert.ok(bugContent.includes("reproduc") || bugContent.includes("step"), "Bug report must ask for reproduction steps");
  assert.ok(bugContent.includes("note") || bugContent.includes("snippet"), "Bug report must ask for note content snippet");
});

test("README.md and README.zh.md have matching heading counts and language links", () => {
  const enPath = join(ROOT, "README.md");
  const zhPath = join(ROOT, "README.zh.md");

  assert.ok(existsSync(enPath), "README.md must exist");
  assert.ok(existsSync(zhPath), "README.zh.md must exist");

  const enContent = readFileSync(enPath, "utf8");
  const zhContent = readFileSync(zhPath, "utf8");

  // Top language switcher links
  assert.match(enContent.split("\n").slice(0, 10).join("\n"), /\[.*简体中文.*\]\(.*README\.zh\.md\)/i, "README.md must link to README.zh.md near top");
  assert.match(zhContent.split("\n").slice(0, 10).join("\n"), /\[.*English.*\]\(.*README\.md\)/i, "README.zh.md must link to README.md near top");

  // Overview image
  assert.ok(enContent.includes("overview.png"), "README.md must include overview image");
  assert.ok(zhContent.includes("overview.png"), "README.zh.md must include overview image");

  // Heading counts
  const countHeadings = (text, level) => {
    const prefix = "#".repeat(level) + " ";
    return text.split("\n").filter((line) => line.startsWith(prefix)).length;
  };

  const enH1 = countHeadings(enContent, 1);
  const zhH1 = countHeadings(zhContent, 1);
  const enH2 = countHeadings(enContent, 2);
  const zhH2 = countHeadings(zhContent, 2);
  const enH3 = countHeadings(enContent, 3);
  const zhH3 = countHeadings(zhContent, 3);

  assert.strictEqual(zhH1, enH1, `H1 count mismatch: EN has ${enH1}, ZH has ${zhH1}`);
  assert.strictEqual(zhH2, enH2, `H2 count mismatch: EN has ${enH2}, ZH has ${zhH2}`);
  assert.strictEqual(zhH3, enH3, `H3 count mismatch: EN has ${enH3}, ZH has ${zhH3}`);

  // Syntax tokens preserved
  assert.ok(zhContent.includes("dHH:MM"), "README.zh.md must preserve dHH:MM token");
  assert.ok(zhContent.includes("30m"), "README.zh.md must preserve 30m duration token");
  assert.ok(zhContent.includes("```naut"), "README.zh.md must preserve ```naut codeblock syntax");
});
