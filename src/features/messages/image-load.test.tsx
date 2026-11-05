// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentImage } from "./AttachmentImage";
import * as imageCopy from "./image-copy";
import { ImageReviewStage } from "./ImageReviewStage";

const url = "https://fixture.test/photo.png";
const source = `/api/relay/media?url=${encodeURIComponent(url)}`;
const dimensions = { width: 1200, height: 500 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The row and the viewer resolve the same media source for one attachment.
function Views({ row = true, viewer = true }) {
  return (
    <>
      {row && (
        <section aria-label="Row">
          <AttachmentImage
            attachment={{ url, kind: "image", dimensions }}
            source={source}
          />
        </section>
      )}
      {viewer && (
        <section aria-label="Viewer">
          <ImageReviewStage
            attachments={[{ url, kind: "image" }]}
            selectedUrl={url}
            media={() => source}
            select={() => {}}
            onOpenLink={() => false}
          />
        </section>
      )}
    </>
  );
}
const row = () => within(screen.getByRole("region", { name: "Row" }));
const viewer = () => within(screen.getByRole("region", { name: "Viewer" }));
const image = (region: HTMLElement) => {
  const element = region.querySelector("img");
  if (!element) throw new Error("Missing image");
  return element;
};
const rowImage = () => image(screen.getByRole("region", { name: "Row" }));
const viewerImage = () => image(screen.getByRole("region", { name: "Viewer" }));

it("a viewer opened over a failed row shows the error without requesting it, and its Retry recovers both", () => {
  const view = render(<Views viewer={false} />);
  fireEvent.error(rowImage());
  view.rerender(<Views />);
  expect(viewer().getByRole("status")).toHaveTextContent("Couldn't load image");
  expect(
    screen.getByRole("region", { name: "Viewer" }).querySelector("img"),
  ).toBeNull();

  fireEvent.click(viewer().getByRole("button", { name: "Retry image" }));
  expect(row().getByRole("status")).toHaveTextContent("Loading image…");
  expect(row().getByRole("button", { name: "Retry image" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(viewerImage()).toHaveAttribute("src", source);
  fireEvent.load(viewerImage());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(row().getByRole("link")).toBeInTheDocument();
  expect(rowImage()).toHaveAttribute("src", source);
  expect(viewer().getByRole("img")).toHaveAttribute("src", source);
});

it("a failure in either view fails both, and the row's Retry recovers the viewer", () => {
  render(<Views />);
  fireEvent.error(viewerImage());
  expect(row().getByRole("status")).toHaveTextContent("Couldn't load image");
  fireEvent.click(row().getByRole("button", { name: "Retry image" }));
  expect(viewer().getByRole("status")).toHaveTextContent("Loading image…");
  fireEvent.error(rowImage());
  expect(viewer().getByRole("status")).toHaveTextContent("Couldn't load image");
  expect(row().getByRole("status")).toHaveTextContent("Couldn't load image");

  fireEvent.click(row().getByRole("button", { name: "Retry image" }));
  fireEvent.load(rowImage());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(viewer().getByRole("button", { name: "Zoom in" })).toBeEnabled();
});

it("a row that already shows the pixels keeps them when the viewer fails", async () => {
  const view = render(<Views viewer={false} />);
  const pixels = rowImage();
  Object.defineProperty(pixels, "naturalWidth", { value: dimensions.width });
  Object.defineProperty(pixels, "naturalHeight", { value: dimensions.height });
  Object.defineProperty(pixels, "decode", { value: vi.fn(async () => {}) });
  await act(async () => fireEvent.load(pixels));
  expect(row().getByRole("link")).toHaveAttribute("data-image-ready");

  view.rerender(<Views />);
  fireEvent.error(viewerImage());
  expect(viewer().getByRole("status")).toHaveTextContent("Couldn't load image");
  expect(row().getByRole("link")).toHaveAttribute("data-image-ready");
  expect(rowImage()).toBe(pixels);
  expect(row().queryByRole("status")).not.toBeInTheDocument();
});

it("a viewer that already shows the pixels keeps them when a row fails", () => {
  vi.spyOn(imageCopy, "supportsImageCopy").mockReturnValue(true);
  const view = render(<Views row={false} />);
  const pixels = viewerImage();
  fireEvent.load(pixels);

  view.rerender(<Views />);
  fireEvent.error(rowImage());
  expect(row().getByRole("status")).toHaveTextContent("Couldn't load image");
  expect(viewerImage()).toBe(pixels);
  expect(pixels).toHaveAttribute("src", source);
  expect(viewer().queryByRole("status")).not.toBeInTheDocument();
  expect(viewer().getByRole("button", { name: "Zoom in" })).toBeEnabled();
  expect(viewer().getByRole("button", { name: "Copy image" })).toBeEnabled();
  expect(
    viewer().getByRole("link", { name: "Download image" }),
  ).toHaveAttribute("href", source);
});

it("forgets a failure once no view shows it, so a remounted row requests it again", () => {
  const first = render(<Views viewer={false} />);
  fireEvent.error(rowImage());
  expect(row().getByRole("status")).toBeInTheDocument();
  first.unmount();
  render(<Views viewer={false} />);
  expect(row().queryByRole("status")).not.toBeInTheDocument();
  expect(rowImage()).toHaveAttribute("src", source);
});

it("a recovery from the viewer moves focus to the row image only from a Retry that still has it", () => {
  const view = render(<Views />);
  const failRow = () => {
    fireEvent.error(rowImage());
    const retry = row().getByRole("button", { name: "Retry image" });
    retry.focus();
    fireEvent.click(retry);
    fireEvent.error(rowImage());
    return retry;
  };
  const recoverInViewer = () => {
    fireEvent.click(viewer().getByRole("button", { name: "Retry image" }));
    fireEvent.load(viewerImage());
  };
  expect(failRow()).toHaveFocus();
  recoverInViewer();
  expect(row().getByRole("link")).toHaveFocus();

  // Lost focus belongs to the viewer whose Retry recovered the image. A viewer
  // that loaded keeps its pixels, so one is opened again over the failed row.
  view.rerender(<Views viewer={false} />);
  const retry = failRow();
  act(() => retry.blur());
  view.rerender(<Views />);
  recoverInViewer();
  expect(row().getByRole("link")).not.toHaveFocus();
  expect(viewerImage().parentElement).toHaveFocus();
});
