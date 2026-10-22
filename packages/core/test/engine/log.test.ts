import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { LOG_FILE } from "../../src/log/index.js";
import { syncOnce, type Project } from "../../src/engine/index.js";
import { linkedProject, type LinkedProject } from "../watch/project.js";

let linked: LinkedProject;
let project: Project;

beforeEach(async () => {
  linked = await linkedProject();
  project = await linked.open();
});
afterEach(async () => {
  await linked.cleanup();
});

const logText = () =>
  readFile(path.join(project.store.dir, "log", LOG_FILE), "utf8").catch(() => "");

describe("the pass log (REQ-17.0.4)", () => {
  it("records a pass that changed something, and stays quiet for one that didn't", async () => {
    await writeFile(path.join(linked.docs, "a.md"), "x\n");
    await syncOnce(project);
    expect(await logText()).toMatch(/INFO pass: 1 applied, 0 skipped as stale, 0 failed/);
    const before = await logText();
    await syncOnce(project);
    expect(await logText()).toBe(before);
  });

  it("records a pass waiting at the bulk guard", async () => {
    for (let i = 0; i < 30; i++) await writeFile(path.join(linked.docs, `d${i}.md`), `${i}\n`);
    await syncOnce(project);
    for (let i = 0; i < 25; i++) await rm(path.join(linked.docs, `d${i}.md`));
    expect((await syncOnce(project)).outcome).toBe("bulk");
    expect(await logText()).toMatch(/WARN waiting for confirmation: .* 25 files/);
  }, 30_000);
});
