import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { useAppStore, type Toast } from "@/stores/app-store";
import type { FileViewEntry } from "@/types";

import { FileView } from "./FileView";

afterEach(() => vi.unstubAllGlobals());

it("deletes checked files individually, retains a failed selection and restores one record", async () => {
  const entry = (name: string, role: FileViewEntry["role"] = "unreferenced"): FileViewEntry => ({
    name, path: name, type: "file", size: 10, modified_at: "2026-01-01T00:00:00Z", role,
  });
  const files = new Map([
    ...["a.txt", "b.txt", "c.txt"].map((name) => [name, entry(name)] as const),
    ["project.json", entry("project.json", "structure")] as const,
    ["source.txt", { ...entry("source.txt"), owner: { kind: "source" as const } }] as const,
  ]);
  const deleted: string[] = [];
  const restored: string[] = [];
  const toasts: Toast[] = [];
  onTestFinished(useAppStore.subscribe((state, previous) => {
    if (state.toast && state.toast !== previous.toast) toasts.push(state.toast);
  }));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.searchParams.get("path") ?? "";
    if (init?.method === "DELETE") {
      deleted.push(path);
      if (path === "b.txt") return Response.json({ detail: "file is now referenced" }, { status: 409 });
      files.delete(path);
      return Response.json({ record: { id: `record-${path}` } });
    }
    if (init?.method === "POST") {
      restored.push(url.pathname);
      files.set("c.txt", entry("c.txt"));
      return Response.json({ restored: [{ original: "c.txt", path: "c.txt", as_history: false }] });
    }
    return Response.json({ path: "", entries: [...files.values()] });
  });
  render(<FileView projectName="demo" />);
  const user = userEvent.setup();
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await user.click(await screen.findByRole("checkbox", { name: `选择 ${name}` }));
  }
  expect(screen.queryByRole("checkbox", { name: "选择 project.json" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "选择 source.txt" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "移入项目回收站（3）" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "移入项目回收站（1）" })).toBeEnabled());
  expect(deleted).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(screen.getByRole("checkbox", { name: "选择 b.txt" })).toBeChecked();
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "选择 c.txt" })).not.toBeInTheDocument());
  expect(toasts.some((toast) => toast.text.includes("b.txt") && toast.tone === "error")).toBe(true);
  const action = toasts.find((toast) => toast.text.startsWith("c.txt "))?.action;
  expect(action?.label).toBe("恢复");
  act(() => action?.onClick());
  await screen.findByRole("checkbox", { name: "选择 c.txt" });
  expect(restored).toEqual(["/api/v1/projects/demo/trash/record-c.txt/restore"]);
  expect(files.has("a.txt")).toBe(false);
});

it("ignores an older directory response after refresh has taken over", async () => {
  let finishOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  let calls = 0;
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      oldSignal = init?.signal;
      return new Promise<Response>((resolve) => { finishOld = resolve; });
    }
    return Promise.resolve(Response.json({ path: "", entries: [] }));
  });
  render(<FileView projectName="demo" />);
  await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText("空目录");
  expect(oldSignal?.aborted).toBe(true);

  await act(async () => {
    finishOld(Response.json({
      path: "", entries: [{ name: "old.txt", path: "old.txt", type: "file", role: "unreferenced", size: 1 }],
    }));
  });

  expect(screen.queryByRole("button", { name: /old\.txt/ })).not.toBeInTheDocument();
});

it("refreshes the selected file's details and preview when it changed on disk", async () => {
  let file: FileViewEntry = {
    name: "note.txt", path: "note.txt", type: "file", size: 3, modified_at: "2026-01-01T00:00:00Z", role: "unreferenced",
  };
  let content = "old";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/file-view/content")) return new Response(content);
    return Response.json({ path: "", entries: [file] });
  });
  render(<FileView projectName="demo" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /note\.txt/ }));
  expect(await screen.findByText("old")).toBeInTheDocument();

  file = { ...file, size: 7, modified_at: "2026-01-02T00:00:00Z" };
  content = "rewrite";
  await user.click(screen.getByRole("button", { name: "刷新" }));

  expect(await screen.findByText("rewrite")).toBeInTheDocument();
});

it("keeps each in-flight restore protected until its own request finishes", async () => {
  const record = (id: string) => ({
    id, object: { kind: "file", path: `${id}.txt` }, files: [`${id}.txt`], schema_version: 1,
    deleted_at: "2026-01-01T00:00:00Z", origin: "user", size: 1, has_snapshot: false,
  });
  const pending = new Map<string, () => void>();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "POST") {
      const id = url.pathname.split("/").at(-2) ?? "";
      return new Promise<Response>((resolve) => {
        pending.set(id, () => resolve(Response.json({ restored: [{ original: `${id}.txt`, path: `${id}.txt`, as_history: false }] })));
      });
    }
    if (url.pathname.endsWith("/trash")) {
      return Promise.resolve(Response.json({ records: [record("a"), record("b")], total_size: 2, retention_days: 30 }));
    }
    return Promise.resolve(Response.json({ path: "", entries: [] }));
  });
  render(<FileView projectName="demo" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "项目回收站" }));
  const [restoreA, restoreB] = await screen.findAllByRole("button", { name: "恢复" });
  await user.click(restoreA);
  await user.click(restoreB);
  await waitFor(() => expect(pending.size).toBe(2));

  await act(async () => pending.get("b")?.());

  await waitFor(() => expect(screen.getAllByRole("button", { name: "恢复" })[1]).toBeEnabled());
  expect(screen.getAllByRole("button", { name: "恢复" })[0]).toBeDisabled();
});
