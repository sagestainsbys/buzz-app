// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import type { ChannelWindow } from "../relay/contracts";
import { keypair, message, scriptedTransport } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";
import type { PageNavigation } from "../navigation/service";
import type { JsonValue } from "../navigation/targets";

// Real React lifecycle; only the virtualizer's imperative layout boundary is
// modeled here. Browser journeys retain the actual same-message/4px contract.
const scroll = vi.hoisted(() => ({
  toIndex: vi.fn(),
  toOffset: vi.fn(),
  itemOffset: vi.fn((_index: number) => 0),
  size: undefined as number | undefined,
  resized: () => {},
}));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children, onResize }: { children: ReactNode; onResize?: () => void },
      ref,
    ) {
      scroll.resized = onResize ?? (() => {});
      const list = useRef<HTMLOListElement>(null);
      useImperativeHandle(ref, () => ({
        cache: undefined,
        get scrollSize() {
          return (
            scroll.size ?? Number.parseFloat(list.current?.style.height ?? "0")
          );
        },
        findItemIndex: () => 0,
        getItemOffset: scroll.itemOffset,
        scrollToIndex: scroll.toIndex,
        scrollTo: scroll.toOffset,
      }));
      return (
        <ol ref={list} style={{ height: 2000 }}>
          {children}
        </ol>
      );
    }),
  };
});
const frames = new Map<number, FrameRequestCallback>();
const resizes = new Set<() => void>();
let nextFrame = 0;
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  scroll.toIndex.mockClear();
  scroll.toOffset.mockClear();
  scroll.itemOffset.mockReset().mockReturnValue(0);
  scroll.size = undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizes.add(this.callback);
      }
      disconnect() {
        resizes.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}
function mount(bottom = false, revealOnMount = false, anchorLoaded = true) {
  const viewer = keypair(),
    relay = keypair();
  const target = message(viewer, "c", "Saved reading anchor", 1);
  const earlier = message(viewer, "c", "Earlier message", 0);
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  writeView("scope", "scroll:c", {
    offset: 900,
    bottom,
    anchor: { id: target.id, y: 42 },
  });
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "cached",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [anchorLoaded ? target : earlier].map((event) => ({
      id: event.id,
      channelId: "c",
      authorId: viewer.pubkey,
      content: event.content,
      createdAt: event.created_at,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    })),
  };
  const tree = (snapshot: ChannelWindow, revealMessageId?: string) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const first = window.rows[0];
  if (!first) throw new Error("Missing fixture row");
  const sent = { ...first, id: "sent", content: "New message" };
  const older = {
    ...first,
    id: "older",
    content: "Older history",
    createdAt: 0,
  };
  const sentWindow = { ...window, rows: [...window.rows, sent] };
  const result = render(
    revealOnMount ? tree(sentWindow, sent.id) : tree(window),
  );
  return {
    saved: { offset: 900, bottom, anchor: { id: target.id, y: 42 } },
    unmount: result.unmount,
    /** A reload never runs unmount cleanup; reopen from what storage holds. */
    reload() {
      const write = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {});
      result.unmount();
      write.mockRestore();
      scroll.toIndex.mockClear();
      render(tree(window));
    },
    reveal() {
      result.rerender(tree(sentWindow, sent.id));
    },
    refreshSent() {
      result.rerender(
        tree({ ...sentWindow, rows: [...sentWindow.rows] }, sent.id),
      );
    },
    awaitReveal() {
      result.rerender(tree(window, sent.id));
    },
    prependOlder() {
      // An older-history page lands while the sent row is still revealing.
      result.rerender(
        tree({ ...sentWindow, rows: [older, ...sentWindow.rows] }, sent.id),
      );
    },
    /** The network head lands after the saved head, with the saved row in it. */
    loadAnchor() {
      result.rerender(
        tree({ ...window, rows: [first, { ...first, id: target.id }] }),
      );
    },
    loadActivityAnchor() {
      result.rerender(
        tree({
          ...window,
          rows: [
            first,
            {
              ...first,
              id: target.id,
              audience: "agents",
              agentEnvelope: true,
              content: "Saved work step",
            },
            {
              ...first,
              id: "last-step",
              audience: "agents",
              agentEnvelope: true,
              content: "Later work step",
            },
          ],
        }),
      );
    },
    replaceAnchor() {
      const first = window.rows[0];
      if (!first) throw new Error("Missing fixture row");
      result.rerender(
        tree({ ...window, rows: [{ ...first, id: "replacement" }] }),
      );
    },
    promote() {
      result.rerender(
        tree({ ...window, freshness: "verified", rows: [...window.rows] }),
      );
    },
    append() {
      result.rerender(tree(sentWindow));
    },
    pageAroundAnchor() {
      result.rerender(
        tree({ ...sentWindow, rows: [older, ...sentWindow.rows] }),
      );
    },
    async measured() {
      await act(async () => {
        screen.getByRole("list").style.height = "2120px";
        await Promise.resolve(); // deliver the real MutationObserver before rAF
      });
    },
  };
}
it.each([
  { offset: 0, gap: 1400 },
  { offset: 400, gap: 1000 },
  { offset: 400, gap: 40 },
])(
  "refreshes measured geometry without changing reading intent at offset $offset / gap $gap",
  async ({ offset, gap }) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    let rowY = 120;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
    region.scrollTop = offset;
    fireEvent.scroll(region);
    fireEvent(region, new Event("scrollend"));

    // Virtua's measured offsets commit without another scroll event.
    rowY += 238;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      offset + region.clientHeight + gap,
    );
    act(() => scroll.resized());
    h.append();
    await h.measured();
    expect(region.scrollTop).toBe(offset);

    // Measurements during an active hold must still preserve its original Y.
    rowY += 90;
    act(() => scroll.resized());
    await act(async () => {
      screen.getByRole("list").style.height = "2210px";
    });
    expect(region.scrollTop).toBe(offset + 90);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
      anchor: { y: 358 },
    });
  },
);
it.each(
  [
    {
      order: "model first",
      modelHeight: 2420.234375,
      renderedHeight: "2420.23px",
    },
    { order: "DOM first", modelHeight: 2420.4999, renderedHeight: "2420.5px" },
  ].flatMap((layout) =>
    ["none", "wheel first", "correction first", "mutation first"].map(
      (movement) => ({ ...layout, movement }),
    ),
  ),
)(
  "preserves a held reader when a resize scroll precedes height reconciliation ($order, $movement)",
  async ({ order, modelHeight, renderedHeight, movement }) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(
          0,
          this.closest("ol") ? 520 - region.scrollTop : 0,
          800,
          100,
        );
      },
    );
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    fireEvent.pointerDown(region);
    try {
      region.scrollTop = 400;
      fireEvent.scroll(region);
      h.pageAroundAnchor();
      await h.measured();
      expect(region.scrollTop).toBe(400);
      const list = screen.getByRole("list");
      if (order === "model first") scroll.size = modelHeight;
      await act(async () => {
        if (order === "DOM first") {
          scroll.size = modelHeight;
          list.style.height = renderedHeight;
        }
        // Virtua's native correction can arrive before React publishes its height
        // or before the real MutationObserver reconciles that publication.
        if (movement !== "none") fireEvent.wheel(region, { deltaY: -50 });
        if (movement === "wheel first") region.scrollTop -= 50;
        const before = region.scrollTop;
        region.scrollTop -= 137;
        region.dispatchEvent(
          new CustomEvent("virtua-scroll-correction", {
            detail: { before, after: region.scrollTop },
          }),
        );
        if (movement === "correction first" || movement === "mutation first")
          region.scrollTop -= 50;
        if (movement !== "mutation first") fireEvent.scroll(region);
        list.style.height = renderedHeight;
        await Promise.resolve();
      });
      if (movement === "mutation first") fireEvent.scroll(region);
      const expected = movement === "none" ? 400 : 350;
      expect(region.scrollTop).toBe(expected);

      // With reconciled geometry, the same held pointer must still move freely.
      region.scrollTop -= 50;
      fireEvent.scroll(region);
      await act(async () => {
        scroll.size = 2500;
        list.style.height = "2500px";
        await Promise.resolve();
      });
      expect(region.scrollTop).toBe(expected - 50);
    } finally {
      fireEvent.pointerUp(region);
    }
  },
);
it("retargets the visible row after movement consumed at a correction boundary", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let growth = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-message-id]");
      const id = row?.dataset.messageId;
      const top = id === "sent" ? 1200 + growth : id === "older" ? 0 : 520;
      return new DOMRect(0, row ? top - region.scrollTop : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  region.scrollTop = 400;
  fireEvent.scroll(region);
  h.pageAroundAnchor();
  await h.measured();
  try {
    fireEvent.wheel(region, { deltaY: 500 });
    region.scrollTop = 900;
    scroll.size = 2420;
    region.scrollTop -= 137;
    region.dispatchEvent(
      new CustomEvent("virtua-scroll-correction", {
        detail: { before: 900, after: region.scrollTop },
      }),
    );
    await act(async () => {
      screen.getByRole("list").style.height = "2420px";
    });
    expect(region.scrollTop).toBe(900);
    fireEvent.scroll(region);
    growth = 90;
    await act(async () => {
      scroll.size = 2510;
      screen.getByRole("list").style.height = "2510px";
    });
    expect(region.scrollTop).toBe(990);
  } finally {
    fireEvent.pointerUp(region);
  }
});
it.each([300, 300.4])(
  "does not treat browser shrink clamping as movement from a held pointer (%s)",
  async (clamp) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(
          0,
          this.closest("ol") ? 520 - region.scrollTop : 0,
          800,
          100,
        );
      },
    );
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    fireEvent.pointerDown(region);
    region.scrollTop = 400;
    fireEvent.scroll(region);
    h.pageAroundAnchor();
    await h.measured();
    let maximum = 1400;
    let offset = region.scrollTop;
    Object.defineProperty(region, "scrollTop", {
      configurable: true,
      get: () => offset,
      set: (value) => {
        offset = Math.max(0, Math.min(maximum, value));
      },
    });
    Object.defineProperty(region, "scrollHeight", {
      configurable: true,
      get: () => Math.trunc(maximum + 600),
    });
    try {
      maximum = clamp;
      region.scrollTop = offset;
      await act(async () => {
        scroll.size = 900;
        screen.getByRole("list").style.height = "900px";
      });
      expect(region.scrollTop).toBe(clamp);
      for (let i = 0; i < 2; i++)
        region.dispatchEvent(
          new CustomEvent("virtua-scroll-correction", {
            detail: { before: clamp, after: clamp },
          }),
        );
      maximum = 1400;
      await act(async () => {
        scroll.size = 2000;
        screen.getByRole("list").style.height = "2000px";
      });
      expect(region.scrollTop).toBe(400);
    } finally {
      fireEvent.pointerUp(region);
    }
  },
);
it("preserves a held reader's logical offset while its DOM lookup is absent", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 120;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  scroll.itemOffset.mockImplementation((index) => index * 100);
  h.pageAroundAnchor();
  await h.measured();
  // A drag after the hold starts must become the new logical baseline.
  region.scrollTop -= 50;
  rowY += 50;
  fireEvent.scroll(region);

  // Model Virtua evicting the lookup, while React still owns the test DOM.
  const row = region.querySelector<HTMLElement>(
    `[data-message-id="${h.saved.anchor.id}"]`,
  );
  expect(row).not.toBeNull();
  row?.removeAttribute("data-message-id");
  scroll.itemOffset.mockImplementation((index) => index * 100 + 45.5);
  const before = region.scrollTop;
  region.scrollTop = 423; // Virtua has already applied part of the batch.
  region.dispatchEvent(
    new CustomEvent("virtua-scroll-correction", {
      detail: { before, after: region.scrollTop },
    }),
  );
  await act(async () => {
    screen.getByRole("list").style.height = "2210px";
  });
  expect(region.scrollTop).toBe(495.5);

  // Another virtualized batch must not undo the drag or double-count a jump.
  scroll.itemOffset.mockImplementation((index) => index * 100 + 135.5);
  const beforeNext = region.scrollTop;
  region.scrollTop += 10;
  region.dispatchEvent(
    new CustomEvent("virtua-scroll-correction", {
      detail: { before: beforeNext, after: region.scrollTop },
    }),
  );
  await act(async () => {
    screen.getByRole("list").style.height = "2300px";
  });
  expect(region.scrollTop).toBe(585.5);
});

it("keeps a held reader when measured row offsets change without total height", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 120;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.append();
  await h.measured();
  const list = screen.getByRole("list");
  const height = list.style.height;
  // Virtua can toggle pointer-events before this gesture's scroll reader runs.
  // That list-only change must not pull the drag back to its previous anchor.
  region.scrollTop -= 50;
  rowY += 50;
  await act(async () => {
    list.style.pointerEvents = "none";
  });
  expect(region.scrollTop).toBe(350);
  fireEvent.scroll(region);
  // Equal and opposite row resizes leave the total unchanged, while Virtua's
  // partial compensation moves the held paragraph up by 113px.
  const before = region.scrollTop;
  region.scrollTop += 113;
  region.dispatchEvent(
    new CustomEvent("virtua-scroll-correction", {
      detail: { before, after: region.scrollTop },
    }),
  );
  rowY -= 113;
  await act(async () => {
    (list.firstElementChild as HTMLElement).style.top = "113px";
  });
  expect(list.style.height).toBe(height);
  expect(region.scrollTop).toBe(350);
});

it("keeps fractional correction residue from accumulating during a held drag", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let offset = 0;
  let rowTop = 1520;
  // WebKit quantizes scrollTop even when measured row offsets are fractional.
  Object.defineProperty(region, "scrollTop", {
    configurable: true,
    get: () => offset,
    set: (value: number) => {
      offset = Math.trunc(value);
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowTop - offset : 0, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  rowTop = 520;
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.append();
  await h.measured();
  let expectedY = 120;
  for (let step = 0; step < 8; step++) {
    rowTop += 1.75;
    await act(async () => {
      (screen.getByRole("list").firstElementChild as HTMLElement).style.top =
        `${step + 1}px`;
    });
    // The automatic correction emits a scroll event; it is not a new user position.
    fireEvent.scroll(region);
    expect(Math.abs(rowTop - offset - expectedY)).toBeLessThan(1);
    if (step === 3) {
      region.scrollTop -= 150;
      expectedY += 150;
      fireEvent.scroll(region);
    }
  }
  fireEvent.pointerUp(region);
});

it("retargets a held reader when its former row is below the viewport", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let formerY = 120;
  let olderY = -200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-message-id]");
      const y = row?.dataset.messageId === "older" ? olderY : row ? formerY : 0;
      return new DOMRect(0, y, 800, 100);
    },
  );
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.keyDown(region, { key: "Home", ctrlKey: true });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  fireEvent.pointerDown(region);
  h.pageAroundAnchor();
  await h.measured();

  // Scrolling away selects the newly visible older row. The former reader's
  // DOM can return below the viewport without reclaiming the active hold.
  formerY = 900;
  olderY = 100;
  region.scrollTop = 0;
  fireEvent.scroll(region);
  formerY += 300;
  await act(async () => {
    screen.getByRole("list").style.height = "2420px";
  });
  expect(region.scrollTop).toBe(0);
});

it("retains the saved anchor correction when cached rows are promoted before its frame", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  scroll.toIndex.mockClear();
  await h.measured();
  h.promote();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
});
it("reader input cancels the queued correction even when cached rows are then promoted", async () => {
  const h = mount();
  await frame();
  scroll.toIndex.mockClear();
  await h.measured();
  fireEvent.wheel(
    screen.getByRole("region", { name: "Channel message history" }),
  );
  h.promote();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "local reveal retires restoration without canceling existing bottom follow=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    const calls = scroll.toIndex.mock.calls.length;
    await h.measured();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    expect(scroll.toIndex.mock.calls.length).toBe(calls + 1);
  },
);

it.each(["none", "wheel", "key"])(
  "a reveal on mount follows late measurements unless reader input=%s",
  async (input) => {
    const h = mount(false, true);
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    if (input === "key") fireEvent.keyDown(feed, { key: "PageUp" });
    await h.measured();
    await frame();
    if (input === "none") {
      expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
      h.unmount();
      expect(readView("scope", "scroll:c", null)).toMatchObject({
        bottom: true,
      });
    } else expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each(["wheel", "key"])(
  "reader input before the reveal frame stays authoritative after a row refresh or prepend: %s",
  async (input) => {
    const h = mount();
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    else fireEvent.keyDown(feed, { key: "PageUp" });
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // A later echo/edit replaces rows; it must not revive the canceled reveal.
    h.refreshSent();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // Nor may an older-history page, which reruns the effect as a prepend.
    h.prependOlder();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "an older-history prepend before the reveal frame still reveals the sent row, read up first=%s",
  async (readUp) => {
    const h = mount(true);
    await frame();
    await frame();
    if (readUp) {
      fireEvent.wheel(
        screen.getByRole("region", { name: "Channel message history" }),
      );
      await frame();
    }
    scroll.toIndex.mockClear();
    h.reveal();
    // The prepend cancels the reveal frame before it runs; the rerun must
    // reschedule the reveal at the sent row's new index, not lose it.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(2, { align: "end" });
    expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  },
);

it.each([false, true])(
  "a completed reveal is not rescheduled by a later older-history prepend, bottom=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    // The reveal is recorded only once its scroll runs. A page landing after
    // that must find it complete, not reschedule it at the sent row's new index.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it("waits for a sent row to arrive without restoring over its reveal", async () => {
  const h = mount();
  await frame();
  h.awaitReveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  h.reveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "the first intermediate bottom-follow scroll retains intent unless reader input=%s",
  async (readerInput) => {
    const h = mount(true);
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Virtua can deliver an intermediate offset before measuring its final range.
    feed.scrollTop = 162;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    scroll.toIndex.mockClear();
    await h.measured();
    await frame();
    if (readerInput) expect(scroll.toIndex).not.toHaveBeenCalled();
    else expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  },
);

it("a resize before the local reveal scroll event cannot revive the prior reading anchor", async () => {
  const h = mount();
  await frame();
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  // Composer/sidebar layout may resize before the browser delivers scroll.
  await act(async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    for (const resize of resizes) resize();
  });
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each([false, true])(
  "a scroll before any visible virtual row mounts retains restoration unless reader input=%s",
  async (readerInput) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // The virtualizer has accepted the offset, but its mounted range is still
    // offscreen. No paragraph or row is available to replace the saved anchor.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? -200 : 0, 800, 100);
      },
    );
    feed.scrollTop = 900;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(
      readerInput ? { bottom: false } : h.saved,
    );
  },
);

it.each([false, true])(
  "does not turn cold clamps into reader follow intent, repeated=%s",
  async (repeat) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Cold estimated row heights can clamp the restoring viewport to the bottom.
    // The saved row is mounted, so this is not the anchorless-range case above.
    let rowY = 84;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    if (repeat) {
      feed.scrollTop = 1200;
      rowY = 284;
      fireEvent.scroll(feed);
      feed.scrollTop = 1400;
      rowY = 84;
      fireEvent.scroll(feed);
    }
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  },
);

it.each(["converged", "gesture", "removed"])(
  "allows bottom follow after restoration is superseded: %s",
  async (boundary) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 42 : 0, 800, 100);
      },
    );
    if (boundary === "converged") {
      feed.scrollTop = 900;
      fireEvent.scroll(feed);
    } else if (boundary === "gesture") {
      fireEvent.pointerDown(feed);
    } else {
      h.replaceAnchor();
      await frame();
    }
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    h.unmount();
    expect(
      readView<{ bottom: boolean }>("scope", "scroll:c", { bottom: false })
        .bottom,
    ).toBe(true);
  },
);

// Intent and native/virtualizer shrink can arrive in one scroll observation.
it.each([
  "wheel",
  "touch",
  "keyboard",
  "link",
  "button",
  "command up",
  "option up",
  "control up",
  "control home",
  "nested top",
  "contained top",
  "no overscroll",
] as const)(
  "%s reader input wins over shrink in the same observation",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -200 });
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (
      [
        "link",
        "button",
        "command up",
        "option up",
        "control up",
        "control home",
        "nested top",
        "contained top",
        "no overscroll",
      ].includes(input)
    ) {
      const control = document.createElement(
        input === "button" ? "button" : "a",
      );
      if (control instanceof HTMLAnchorElement)
        control.href = "https://example.com";
      control.textContent = "Message control";
      region.append(control);
      if (["nested top", "contained top", "no overscroll"].includes(input)) {
        const inner = document.createElement("div");
        inner.style.overflowY = "auto";
        inner.style.overscrollBehaviorY =
          input === "contained top"
            ? "contain"
            : input === "no overscroll"
              ? "none"
              : "auto";
        region.append(inner);
        inner.append(control);
        inner.scrollTop = 0;
      }
      control.focus();
      fireEvent.keyDown(control, {
        key: input.endsWith("up")
          ? "ArrowUp"
          : input === "control home"
            ? "Home"
            : "PageUp",
        metaKey: input === "command up",
        altKey: input === "option up",
        ctrlKey: input.startsWith("control"),
      });
    }
    if (input === "touch") {
      fireEvent.touchStart(region, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(region, { touches: [{ clientY: 300 }] });
    }
    // No intermediate stable-height scroll: native clamp, virtualizer correction
    // and the reader's movement are first seen together.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);
it.each(["keyboard", "wheel", "scrollbar"])(
  "%s movement survives a frame and shrink during the same gesture",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -300 });
    if (input === "scrollbar") fireEvent.pointerDown(region);
    // The first event has not yet crossed the near-bottom threshold. A native
    // smooth scroll / drag continues after this rendering opportunity.
    region.scrollTop -= 40;
    fireEvent.scroll(region);
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1920,
    );
    region.scrollTop -= 340; // 80px shrink plus 260px continued reader movement.
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);

it.each(["auto", "contain", "none"])(
  "retires an unconsumed %s inner-top PageUp before a later layout-only shrink",
  async (containment) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.style.overscrollBehaviorY = containment;
    const control = document.createElement("a");
    control.href = "https://example.com";
    inner.append(control);
    region.append(inner);
    control.focus();
    fireEvent.keyDown(control, { key: "PageUp" });
    // WebKit can consume this key without moving either scrollport. No scroll or
    // scrollend follows; let that rendering opportunity pass before later reflow.
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 800;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);

it("a finished near-bottom wheel does not taint a later layout-only shrink", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.wheel(region, { deltaY: -1 });
  region.scrollTop -= 1;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1600);
  region.scrollTop = 600;
  fireEvent.scroll(region);
  h.promote();
  await frame();
  h.unmount();
  expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
});

it.each([
  "editable",
  "nested scroll",
  "prevented",
  "button activation",
  "modified page up",
] as const)(
  "%s keyboard input does not claim history scrolling during shrink",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const control = document.createElement(
      input === "editable" ? "textarea" : "button",
    );
    region.append(control);
    if (input === "nested scroll") {
      const inner = document.createElement("div");
      inner.style.overflowY = "auto";
      region.append(inner);
      inner.append(control);
      inner.scrollTop = 100;
    }
    if (input === "prevented")
      control.addEventListener("keydown", (event) => event.preventDefault());
    control.focus();
    fireEvent.keyDown(control, {
      key: input === "button activation" ? " " : "PageUp",
      shiftKey: input === "button activation",
      altKey: input === "modified page up",
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    h.promote();
    await frame();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);

it("reads through the last message when a Huddle card is newest, with no plugin renderer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 800, 500),
  ] as unknown as DOMRectList);
  const owner = createRelaySession(null);
  owners.push(owner);
  const catchUp = vi.fn(async () => {}),
    observe = vi.fn(async () => {});
  const sync = {
    ...owner.session.unread.sync(),
    capability: "frontier-sync" as const,
  };
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      sync: () => sync,
      reading: () => ({ view: () => {}, dispose: () => {}, observe, catchUp }),
    },
  };
  const base = {
    channelId: "c",
    authorId: "a".repeat(64),
    content: "Message",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  try {
    render(
      <ChannelTimeline
        channelId="c"
        scope="read-huddle"
        queries={session}
        window={{
          channelId: "c",
          status: "ready",
          freshness: "verified",
          error: undefined,
          hasMore: false,
          loadingOlder: false,
          rows: [
            { ...base, id: "message" },
            {
              ...base,
              id: "card",
              content: "",
              createdAt: 2,
              huddle: { room: "room", state: "started" },
            },
          ],
        }}
        onOpenLink={() => false}
      />,
    );
    await frame();
    await frame();
    const history = screen.getByRole("region", {
      name: "Channel message history",
    });
    await act(async () => {
      history.focus();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(catchUp).toHaveBeenCalledWith("message", undefined);
    expect(observe).toHaveBeenCalledWith(["message"]);
    expect(
      history
        .querySelector('[data-message-id="card"]')
        ?.hasAttribute("data-huddle-row"),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("scroll completion saves row geometry measured after the last scroll event", async () => {
  const h = mount();
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  let rowY = 42;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
    },
  );
  fireEvent.wheel(region, { deltaY: -900 });
  region.scrollTop = 0;
  fireEvent.scroll(region);
  // Virtual rows finish measuring at the top without changing scrollTop again.
  rowY = 142;
  fireEvent(region, new Event("scrollend"));
  h.unmount();
  expect(readView("scope", "scroll:c", null)).toEqual({
    bottom: false,
    anchor: { id: h.saved.anchor.id, y: 142 },
  });
});

it("catching up saves the bottom once scrolling settles, so a reload opens at the latest message", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  fireEvent.wheel(region, { deltaY: 600 });
  for (const top of [700, 1100, 1400]) {
    region.scrollTop = top;
    fireEvent.scroll(region);
  }
  // Scroll events update the place in memory only.
  expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  fireEvent(region, new Event("scrollend"));
  expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  h.reload();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each(["scrollend", "pagehide"])(
  "a reload reopens the message a reader stopped at, at the same y, saved on %s",
  async (save) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 120 : 0, 800, 100);
      },
    );
    fireEvent.wheel(region, { deltaY: -400 });
    region.scrollTop = 400;
    fireEvent.scroll(region);
    if (save === "scrollend") fireEvent(region, new Event("scrollend"));
    else fireEvent(window, new Event("pagehide"));
    h.reload();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -120,
    });
  },
);

it("a saved row missing from the first rows stays pending: the reader follows, scrollend keeps the place, and its arrival restores it", async () => {
  const h = mount(false, false, false);
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  expect(scroll.toOffset).not.toHaveBeenCalled();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  // The timeline's own scroll to the end settles; the saved place survives it.
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  scroll.toIndex.mockClear();
  h.loadAnchor();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
});

/** A focused reader reopening at a saved row the first rows do not hold yet. */
async function pendingReader() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        800,
        this.getAttribute("aria-label") === "Channel message history"
          ? 500
          : this.dataset.messageId
            ? 80
            : 0,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 800, 500),
  ] as unknown as DOMRectList);
  const owner = createRelaySession(null);
  owners.push(owner);
  const catchUp = vi.fn(async () => {}),
    observe = vi.fn(async () => {});
  const sync = {
    ...owner.session.unread.sync(),
    capability: "frontier-sync" as const,
  };
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      sync: () => sync,
      reading: () => ({ view: () => {}, dispose: () => {}, observe, catchUp }),
    },
  };
  const base = {
    channelId: "c",
    authorId: "a".repeat(64),
    content: "Message",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const tree = (rows: ChannelWindow["rows"]) => (
    <ChannelTimeline
      channelId="c"
      scope="read-restore"
      queries={session}
      window={{
        channelId: "c",
        status: "ready",
        freshness: "cached",
        error: undefined,
        hasMore: false,
        loadingOlder: false,
        rows,
      }}
      onOpenLink={() => false}
    />
  );
  writeView("read-restore", "scroll:c", {
    bottom: false,
    anchor: { id: "saved", y: 42 },
  });
  const latest = { ...base, id: "latest" };
  const view = render(tree([latest]));
  await frame();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  const history = screen.getByRole("region", {
    name: "Channel message history",
  });
  await act(async () => {
    history.focus();
    await Promise.resolve();
  });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  return {
    history,
    catchUp,
    observe,
    load() {
      view.rerender(tree([{ ...base, id: "saved", createdAt: 0 }, latest]));
    },
  };
}

it("following the latest message while a saved row loads reads the rows shown, but does not catch up past the saved row", async () => {
  try {
    const h = await pendingReader();
    expect(h.observe).toHaveBeenCalledWith(["latest"]);
    expect(h.catchUp).not.toHaveBeenCalled();
    scroll.toIndex.mockClear();
    h.load();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    expect(h.catchUp).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("reader input retires a loading saved row, so a dwell at the latest message catches up", async () => {
  try {
    const h = await pendingReader();
    expect(h.catchUp).not.toHaveBeenCalled();
    fireEvent.keyDown(h.history, { key: "ArrowDown" });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(h.catchUp).toHaveBeenCalledWith("latest", undefined);
  } finally {
    vi.useRealTimers();
  }
});

it("a wheel at the bottom that cannot scroll still retires a loading saved row, so the next dwell catches up", async () => {
  try {
    const h = await pendingReader();
    expect(h.catchUp).not.toHaveBeenCalled();
    // The reader is already at the end: the wheel moves nothing and emits no
    // scroll event, so only the retired restore can wake the dwell.
    fireEvent.wheel(h.history, { deltaY: 100 });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(h.catchUp).toHaveBeenCalledWith("latest", undefined);
  } finally {
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "retains delayed activity expansion until arrival unless the reader moves: %s",
  async (readerMoves) => {
    const h = mount(false, false, false);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (readerMoves) fireEvent.wheel(region, { deltaY: -100 });
    h.loadActivityAnchor();
    await frame();
    expect(
      screen
        .getByRole("button", { name: /activity history/ })
        .getAttribute("aria-expanded"),
    ).toBe(String(!readerMoves));
    if (!readerMoves)
      expect(screen.getByText("Saved work step")).not.toBeNull();
  },
);

/** Link visits as navigation keeps them: a visit's place outlives each presentation. */
function linkVisits() {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // Rows are on screen, so a reveal can complete.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 100),
  );
  const viewer = keypair(),
    relay = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  const rows = ["Linked message", "Reading place", "Latest message"].map(
    (content, index) => {
      const event = message(viewer, "c", content, index);
      return {
        id: event.id,
        channelId: "c",
        authorId: viewer.pubkey,
        content,
        createdAt: index,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      };
    },
  );
  const [linked, place, latest] = rows;
  if (!linked || !place || !latest) throw new Error("Missing fixture rows");
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "verified",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows,
  };
  const places = new Map<string, JsonValue>();
  const visit = (entryId: string, messageId: string, traversal?: true) =>
    ({
      entryId,
      target: {
        version: 1,
        kind: "conversation",
        channelId: "c",
        messageId,
        scope: { viewer: viewer.pubkey, communityOrigin: "https://c.invalid" },
      },
      signal: new AbortController().signal,
      ...(traversal && { traversal }),
      complete: vi.fn<PageNavigation["complete"]>(() => true),
      resolve: vi.fn(() => true),
      forSession: vi.fn<PageNavigation["forSession"]>(),
      position: (key: string) => places.get(`${entryId}:${key}`),
      savePosition(key: string, value: JsonValue) {
        places.set(`${entryId}:${key}`, value);
      },
    }) satisfies PageNavigation;
  const tree = (navigation?: PageNavigation, snapshot = window) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        navigation={navigation}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  let result: ReturnType<typeof render> | undefined;
  const history = () =>
    screen.getByRole("region", { name: "Channel message history" });
  return {
    linked,
    place,
    latest,
    window,
    places,
    visit,
    get history() {
      return history();
    },
    /** The reader's place: the "Reading place" row 42 px below the top. */
    saved: { bottom: false, anchor: { id: place.id, y: 42 } },
    row: (id: string) =>
      history().querySelector<HTMLElement>(`[data-message-id="${id}"]`),
    /** Mounts the timeline for a visit, or presents another on the mounted one. */
    show(navigation?: PageNavigation, snapshot = window) {
      if (result) result.rerender(tree(navigation, snapshot));
      else result = render(tree(navigation, snapshot));
    },
    unmount() {
      result?.unmount();
      result = undefined;
    },
    /** Rows on screen, each `top` px below the top of the history. */
    layout(tops: Record<string, number>) {
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const id =
          this.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
        if (!id) return new DOMRect(0, 0, 800, 600);
        return new DOMRect(0, tops[id] ?? 300, 800, 100);
      });
    },
    /** Run frames until a reveal or restoration has finished. */
    async settle() {
      for (let i = 0; i < 6; i++) await frame();
    },
  };
}

it("Back to a link's visit returns to where the reader left it, without revealing the link", async () => {
  const h = linkVisits();
  h.places.set("link:timeline", h.saved);
  const back = h.visit("link", h.linked.id, true);
  // The timeline mounts for the return, as it does coming back from another channel.
  h.show(back);
  await h.settle();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, expect.anything());
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  // Nothing else completes a link's visit once its reveal is skipped, and
  // StrictMode's second effect pass doesn't complete it again.
  expect(back.complete).toHaveBeenCalledTimes(1);
  expect(back.complete).toHaveBeenCalledWith({ status: "opened" });
  // Focus the opener left behind moves to the restored reading.
  expect(document.activeElement).toBe(h.history);
});

it("leaving a visit Back returned to records where the reader read on to", async () => {
  const h = linkVisits();
  h.places.set("link:timeline", h.saved);
  h.show(h.visit("link", h.linked.id, true));
  await h.settle();
  // The reader reads on until "Latest message" is the first whole row.
  fireEvent.wheel(h.history, { deltaY: 200 });
  h.layout({ [h.linked.id]: -300, [h.place.id]: -150, [h.latest.id]: 20 });
  h.history.scrollTop = 600;
  fireEvent.scroll(h.history);
  h.show(h.visit("next", h.latest.id));
  expect(h.places.get("link:timeline")).toEqual({
    bottom: false,
    anchor: { id: h.latest.id, y: 20 },
  });
});

it("a mounted timeline records a link's place as the reader leaves it, and Back returns there", async () => {
  const h = linkVisits();
  h.show();
  const first = h.visit("first", h.linked.id);
  h.show(first);
  await h.settle();
  expect(document.activeElement).toBe(h.row(h.linked.id));
  expect(first.complete).toHaveBeenCalledWith({ status: "opened" });
  // The reader scrolls on until "Reading place" is the first whole row.
  h.layout({ [h.linked.id]: -200, [h.place.id]: 42 });
  h.history.scrollTop = 500;
  fireEvent.scroll(h.history);
  expect(h.places.has("first:timeline")).toBe(false);
  // Following another link in the same channel leaves the first visit.
  const second = h.visit("second", h.latest.id);
  h.show(second);
  expect(h.places.get("first:timeline")).toEqual(h.saved);
  await h.settle();
  expect(document.activeElement).toBe(h.row(h.latest.id));
  scroll.toIndex.mockClear();
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  const back = h.visit("first", h.linked.id, true);
  h.show(back);
  expect(h.places.has("second:timeline")).toBe(true);
  await h.settle();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(back.complete).toHaveBeenCalledTimes(1);
  expect(back.complete).toHaveBeenCalledWith({ status: "opened" });
  // Focus on the row the second link revealed moves to the restored reading.
  expect(document.activeElement).toBe(h.history);
});

it("Back leaves focus the reader moved to another row where it is", async () => {
  const h = linkVisits();
  h.show(h.visit("first", h.linked.id));
  await h.settle();
  h.show(h.visit("second", h.latest.id));
  await h.settle();
  h.row(h.linked.id)?.focus();
  h.show(h.visit("first", h.linked.id, true));
  await h.settle();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(h.row(h.linked.id));
});

it("Back leaves focus on a row's control when this timeline revealed nothing", async () => {
  const h = linkVisits();
  h.places.set("link:timeline", h.saved);
  h.show();
  await h.settle();
  const row = h.row(h.latest.id);
  if (!row) throw new Error("Missing latest row");
  const actions = within(row).getByRole("button", {
    name: "More message actions",
  });
  actions.focus();
  h.show(h.visit("link", h.linked.id, true));
  await h.settle();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -42,
  });
  expect(document.activeElement).toBe(actions);
});

it("Back to a place inside agent activity opens its group", async () => {
  const h = linkVisits();
  h.places.set("link:timeline", h.saved);
  const step = (id: string, content: string) => ({
    ...h.place,
    id,
    audience: "agents" as const,
    agentEnvelope: true,
    content,
  });
  h.show(h.visit("link", h.linked.id, true), {
    ...h.window,
    // No reply follows the steps, so their group stays shown, folded.
    rows: [
      h.linked,
      step(h.place.id, "Saved work step"),
      step("later-step", "Later work step"),
    ],
  });
  await h.settle();
  expect(
    screen
      .getByRole("button", { name: /activity history/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.getByText("Saved work step")).not.toBeNull();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(
    1,
    expect.objectContaining({ align: "start" }),
  );
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it("a relay rebind of the visit Back returned to leaves the reader where they are", async () => {
  const h = linkVisits();
  h.places.set("link:timeline", h.saved);
  const back = h.visit("link", h.linked.id, true);
  h.show(back);
  await h.settle();
  // The reader reads on and puts focus down before the session's snapshot changes.
  fireEvent.wheel(h.history, { deltaY: 200 });
  h.layout({ [h.linked.id]: -400, [h.place.id]: -200, [h.latest.id]: 0 });
  h.history.scrollTop = 200;
  fireEvent.scroll(h.history);
  h.history.blur();
  scroll.toIndex.mockClear();
  const rebound = {
    ...back,
    signal: new AbortController().signal,
    complete: vi.fn<PageNavigation["complete"]>(() => true),
  };
  // The page passes no navigation for the render that rebinds it.
  h.show();
  h.show(rebound);
  await h.settle();
  expect(scroll.toIndex).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
  expect(rebound.complete).toHaveBeenCalledTimes(1);
});

it("a link's place is where its reveal left the reader, even if nothing scrolled", async () => {
  const h = linkVisits();
  // The link's row, the second-latest message, already sits near the top.
  h.layout({ [h.linked.id]: -90, [h.place.id]: 10, [h.latest.id]: 110 });
  h.show(h.visit("link", h.place.id));
  await h.settle();
  // The reader leaves for another channel without scrolling.
  h.unmount();
  scroll.toIndex.mockClear();
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  h.show(h.visit("link", h.place.id, true));
  await h.settle();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, {
    align: "start",
    offset: -10,
  });
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it.each([
  ["Back to a place no longer loaded", "gone", true],
  ["An opening that isn't Back/Forward, such as Retry", undefined, undefined],
] as const)("%s reveals the link again", async (_, anchor, traversal) => {
  const h = linkVisits();
  h.places.set("link:timeline", {
    bottom: false,
    anchor: { id: anchor ?? h.place.id, y: 42 },
  });
  const navigation = h.visit("link", h.linked.id, traversal);
  h.show(navigation);
  await h.settle();
  const row = h.row(h.linked.id);
  expect(document.activeElement).toBe(row);
  expect(
    vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts,
  ).toContain(row);
  // Nothing positions at the place this visit can't return to.
  expect(scroll.toIndex).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ offset: -42 }),
  );
  expect(navigation.complete).toHaveBeenCalledTimes(1);
  expect(navigation.complete).toHaveBeenCalledWith({ status: "opened" });
});

it("records a link's place only once its visit was presented", async () => {
  const h = linkVisits();
  h.show();
  await h.settle();
  // The reader has a place in the channel before following a link.
  fireEvent.scroll(h.history);
  // A link to a message not loaded: its reveal never runs.
  h.show(h.visit("pending", "f".repeat(64)));
  await h.settle();
  h.show(h.visit("next", h.latest.id));
  h.unmount();
  expect(h.places.has("pending:timeline")).toBe(false);
});
