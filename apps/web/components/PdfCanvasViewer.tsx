"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PageViewport,
  RenderTask,
} from "unpdf/pdfjs";
import {
  createAnnotatedPdf,
  parsePdfAnnotations,
  type PdfAnnotation,
  type PdfInkAnnotation,
  type PdfPoint,
  type PdfTextAnnotation,
} from "@/lib/pdf-annotations";
import { useAppDialog } from "./AppDialogProvider";
import type { UiLanguage } from "@/lib/i18n";

interface Props {
  src: string;
  fileName: string;
  storageKey: string;
  requestedPage?: number | null;
  focusToken?: number;
  focusMode?: boolean;
  onFocusModeChange?: (focused: boolean) => void;
  uiLanguage?: UiLanguage;
}

interface CachedPage {
  canvas: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  links: PdfPageLink[];
}

interface PdfPageLink {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  dest: string | unknown[] | null;
  url: string | null;
  newWindow: boolean;
}

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  newWindow?: boolean;
  items: PdfOutlineNode[];
}

type PdfTool = "pan" | "ink" | "text";

interface RenderedPageSize {
  page: number;
  width: number;
  height: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  dragging: boolean;
}

interface WheelTurnState {
  direction: -1 | 0 | 1;
  distance: number;
  lastEventAt: number;
  cooldownUntil: number;
}

const PAGE_CACHE_LIMIT = 3;
const PAGE_CACHE_PIXEL_BUDGET = 18_000_000;
const MAX_RENDER_PIXELS = 8_000_000;
const RESIZE_RENDER_DELAY_MS = 100;
const WHEEL_PAGE_TURN_THRESHOLD = 42;
const WHEEL_PAGE_TURN_COOLDOWN_MS = 260;
const WHEEL_GESTURE_RESET_MS = 180;
const SCROLL_EDGE_EPSILON = 2;

const controlButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 26,
  padding: 0,
  border: "1px solid color-mix(in srgb, var(--border) 82%, transparent)",
  borderRadius: 5,
  background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

function clampPage(page: number, total: number): number {
  return Math.max(1, Math.min(total || Number.MAX_SAFE_INTEGER, Math.round(page)));
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function annotationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pdf-note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makePageLinks(annotations: unknown[], viewport: PageViewport): PdfPageLink[] {
  const links: PdfPageLink[] = [];
  annotations.forEach((value, index) => {
    if (typeof value !== "object" || value === null) return;
    const annotation = value as {
      id?: unknown;
      subtype?: unknown;
      rect?: unknown;
      dest?: unknown;
      url?: unknown;
      unsafeUrl?: unknown;
      newWindow?: unknown;
    };
    if (annotation.subtype !== "Link" || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) return;
    const first = viewport.convertToViewportPoint(
      Number(annotation.rect[0]),
      Number(annotation.rect[1]),
    ) as number[];
    const second = viewport.convertToViewportPoint(
      Number(annotation.rect[2]),
      Number(annotation.rect[3]),
    ) as number[];
    const rectangle = [first[0], first[1], second[0], second[1]];
    const left = Math.min(rectangle[0], rectangle[2]);
    const top = Math.min(rectangle[1], rectangle[3]);
    const width = Math.abs(rectangle[2] - rectangle[0]);
    const height = Math.abs(rectangle[3] - rectangle[1]);
    if (!Number.isFinite(left + top + width + height) || width < 1 || height < 1) return;
    const dest = typeof annotation.dest === "string" || Array.isArray(annotation.dest)
      ? annotation.dest as string | unknown[]
      : null;
    const rawUrl = typeof annotation.url === "string"
      ? annotation.url
      : typeof annotation.unsafeUrl === "string" ? annotation.unsafeUrl : null;
    if (!dest && !rawUrl) return;
    links.push({
      id: typeof annotation.id === "string" ? annotation.id : `link-${index}`,
      left,
      top,
      width,
      height,
      dest,
      url: rawUrl,
      newWindow: annotation.newWindow === true,
    });
  });
  return links;
}

function annotatedFileName(fileName: string): string {
  return fileName.toLowerCase().endsWith(".pdf")
    ? `${fileName.slice(0, -4)}-annotated.pdf`
    : `${fileName}-annotated.pdf`;
}

function normalizeOutline(value: unknown): PdfOutlineNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PdfOutlineNode[] => {
    if (typeof item !== "object" || item === null) return [];
    const node = item as {
      title?: unknown;
      dest?: unknown;
      url?: unknown;
      unsafeUrl?: unknown;
      newWindow?: unknown;
      items?: unknown;
    };
    if (typeof node.title !== "string") return [];
    const dest = typeof node.dest === "string" || Array.isArray(node.dest)
      ? node.dest as string | unknown[]
      : null;
    const url = typeof node.url === "string"
      ? node.url
      : typeof node.unsafeUrl === "string" ? node.unsafeUrl : null;
    return [{
      title: node.title,
      dest,
      url,
      newWindow: node.newWindow === true,
      items: normalizeOutline(node.items),
    }];
  });
}

interface WritableFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<WritableFileHandle>;
};

async function saveBlobAs(blob: Blob, fileName: string): Promise<boolean> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (pickerError) {
      if (pickerError instanceof DOMException && pickerError.name === "AbortError") return false;
      throw pickerError;
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

function isRenderCancellation(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "RenderingCancelledException"
    || error.message.toLowerCase().includes("rendering cancelled")
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

function PdfOutlineTree({
  items,
  depth = 0,
  onActivate,
}: {
  items: PdfOutlineNode[];
  depth?: number;
  onActivate: (node: PdfOutlineNode) => void;
}) {
  return items.map((item, index) => (
    <div key={`${depth}-${index}-${item.title}`}>
      <button
        type="button"
        disabled={!item.dest && !item.url}
        onClick={() => onActivate(item)}
        title={item.title}
        style={{
          width: "100%",
          minHeight: 28,
          display: "block",
          padding: `4px 8px 4px ${8 + depth * 14}px`,
          border: "none",
          borderRadius: 5,
          background: "transparent",
          color: item.dest || item.url ? "var(--text)" : "var(--text-muted)",
          cursor: item.dest || item.url ? "pointer" : "default",
          textAlign: "left",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        {item.title}
      </button>
      {item.items.length > 0 && (
        <PdfOutlineTree items={item.items} depth={depth + 1} onActivate={onActivate} />
      )}
    </div>
  ));
}

export function PdfCanvasViewer({
  src,
  fileName,
  storageKey,
  requestedPage,
  focusToken,
  focusMode = false,
  onFocusModeChange,
  uiLanguage = "en",
}: Props) {
  const dialog = useAppDialog();
  const zh = uiLanguage === "zh";
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderSequenceRef = useRef(0);
  const pageCacheRef = useRef(new Map<string, CachedPage>());
  const panRef = useRef<PanState | null>(null);
  const pendingPageScrollRef = useRef<"top" | "bottom" | null>(null);
  const handledFocusTokenRef = useRef<number | null>(null);
  const handledInitialPageRef = useRef<number | null>(null);
  const wheelTurnRef = useRef<WheelTurnState>({
    direction: 0,
    distance: 0,
    lastEventAt: 0,
    cooldownUntil: 0,
  });
  const draftInkRef = useRef<PdfPoint[] | null>(null);

  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(() => requestedPage ?? 1);
  const [pageInput, setPageInput] = useState(() => String(requestedPage ?? 1));
  const [zoom, setZoom] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [renderingPage, setRenderingPage] = useState<number | null>(null);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [scrubPage, setScrubPage] = useState<number | null>(null);
  const [pageLinks, setPageLinks] = useState<PdfPageLink[]>([]);
  const [outline, setOutline] = useState<PdfOutlineNode[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [renderedSize, setRenderedSize] = useState<RenderedPageSize | null>(null);
  const [tool, setTool] = useState<PdfTool>("pan");
  const [inkColor, setInkColor] = useState("#ef4444");
  const [inkWidth, setInkWidth] = useState(3);
  const [draftInk, setDraftInk] = useState<PdfPoint[] | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [loadedAnnotationStorageKey, setLoadedAnnotationStorageKey] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [savingCopy, setSavingCopy] = useState(false);
  const [annotationMessage, setAnnotationMessage] = useState<string | null>(null);
  const currentPageRef = useRef(currentPage);
  const pageCountRef = useRef(pageCount);
  currentPageRef.current = currentPage;
  pageCountRef.current = pageCount;
  const annotationLocalStorageKey = useMemo(
    () => `pi-web:pdf-annotations:v1:${storageKey}`,
    [storageKey],
  );
  const currentAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.page === currentPage),
    [annotations, currentPage],
  );

  useEffect(() => {
    setLoadedAnnotationStorageKey(null);
    try {
      const stored = localStorage.getItem(annotationLocalStorageKey);
      setAnnotations(stored ? parsePdfAnnotations(JSON.parse(stored) as unknown) : []);
    } catch {
      setAnnotations([]);
    }
    setLoadedAnnotationStorageKey(annotationLocalStorageKey);
    setEditingNoteId(null);
    setAnnotationMessage(null);
  }, [annotationLocalStorageKey]);

  useEffect(() => {
    if (loadedAnnotationStorageKey !== annotationLocalStorageKey) return;
    try {
      localStorage.setItem(annotationLocalStorageKey, JSON.stringify(annotations));
    } catch {
      // The editor remains usable if browser storage is unavailable or full.
    }
  }, [annotationLocalStorageKey, annotations, loadedAnnotationStorageKey]);

  useEffect(() => {
    if (!focusMode) return;
    setOutlineOpen(false);
    setTool("pan");
    setDraftInk(null);
    setEditingNoteId(null);
  }, [focusMode]);

  const clearPageCache = useCallback(() => {
    canvasHostRef.current?.replaceChildren();
    for (const cached of pageCacheRef.current.values()) {
      cached.canvas.width = 0;
      cached.canvas.height = 0;
    }
    pageCacheRef.current.clear();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let animationFrame: number | null = null;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const commitWidth = () => {
      const width = Math.max(0, Math.floor(viewport.clientWidth));
      // Inactive file tabs remain mounted with display:none. Preserve their
      // last useful width so switching tabs can reuse the rendered bitmap.
      if (width > 0) setViewportWidth((previous) => previous === width ? previous : width);
    };
    commitWidth();
    const scheduleWidthUpdate = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        if (renderTimer !== null) clearTimeout(renderTimer);
        // Resizing the split panel can emit dozens of observations. Wait for
        // it to settle so PDF rendering does not compete with the drag.
        renderTimer = setTimeout(() => {
          renderTimer = null;
          commitWidth();
        }, RESIZE_RENDER_DELAY_MS);
      });
    };
    const observer = new ResizeObserver(scheduleWidthUpdate);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (renderTimer !== null) clearTimeout(renderTimer);
    };
  }, []);

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => {
      const width = Math.max(0, Math.floor(viewportRef.current?.clientWidth ?? 0));
      if (width > 0) setViewportWidth((previous) => previous === width ? previous : width);
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [focusMode]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    loadingTaskRef.current = null;
    clearPageCache();
    setDocumentProxy(null);
    setPageCount(0);
    setRenderedPage(null);
    setRenderingPage(null);
    setRenderedSize(null);
    setPageLinks([]);
    setOutline([]);
    setOutlineOpen(false);
    setError(null);
    setLoadProgress(0);

    void import("unpdf/pdfjs")
      .then(({ getDocument }) => {
        if (cancelled) return null;
        loadingTask = getDocument({
          url: src,
          withCredentials: true,
          rangeChunkSize: 256 * 1024,
          useSystemFonts: true,
          enableHWA: true,
        });
        loadingTaskRef.current = loadingTask;
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          if (cancelled) return;
          setLoadProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null);
        };
        return loadingTask.promise;
      })
      .then((pdf) => {
        if (!pdf || cancelled) return;
        setDocumentProxy(pdf);
        setPageCount(pdf.numPages);
        setLoadProgress(100);
        void pdf.getOutline()
          .then((items) => {
            if (!cancelled) setOutline(normalizeOutline(items));
          })
          .catch(() => {
            if (!cancelled) setOutline([]);
          });
        // Citation requests update currentPage even while a large file is
        // loading. Clamp that latest page when the document becomes ready,
        // without replaying the old citation after a live file refresh.
        setCurrentPage((previousPage) => {
          const nextPage = clampPage(previousPage, pdf.numPages);
          setPageInput(String(nextPage));
          return nextPage;
        });
      })
      .catch((loadError: unknown) => {
        if (cancelled || isRenderCancellation(loadError)) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoadProgress(null);
      });

    return () => {
      cancelled = true;
      renderSequenceRef.current += 1;
      const activeRenderTask = renderTaskRef.current;
      activeRenderTask?.cancel();
      renderTaskRef.current = null;
      clearPageCache();
      if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null;
      if (loadingTask) {
        const renderSettled = activeRenderTask
          ? activeRenderTask.promise.catch(() => undefined)
          : Promise.resolve();
        void renderSettled.finally(() => loadingTask?.destroy());
      }
    };
  }, [clearPageCache, src]);

  useEffect(() => {
    if (!requestedPage) return;

    // A citation is an imperative, one-shot jump. pageCount and live reloads
    // must not replay it after the user has moved elsewhere in the document.
    if (focusToken !== undefined) {
      if (handledFocusTokenRef.current === focusToken) return;
      handledFocusTokenRef.current = focusToken;
    } else {
      if (handledInitialPageRef.current === requestedPage) return;
      handledInitialPageRef.current = requestedPage;
    }

    const nextPage = clampPage(requestedPage, pageCountRef.current);
    pendingPageScrollRef.current = nextPage === currentPageRef.current ? null : "top";
    setCurrentPage(nextPage);
    setPageInput(String(nextPage));
    viewportRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [focusToken, requestedPage]);

  const commitCanvas = useCallback((cached: CachedPage, page: number, sequence: number) => {
    if (sequence !== renderSequenceRef.current) return;
    const host = canvasHostRef.current;
    if (!host) return;
    cached.canvas.style.width = `${cached.cssWidth}px`;
    cached.canvas.style.height = `${cached.cssHeight}px`;
    cached.canvas.setAttribute("aria-label", `${fileName}, page ${page}`);
    host.replaceChildren(cached.canvas);
    if (pageSurfaceRef.current) {
      pageSurfaceRef.current.style.width = `${cached.cssWidth}px`;
      pageSurfaceRef.current.style.height = `${cached.cssHeight}px`;
    }
    setRenderedSize({ page, width: cached.cssWidth, height: cached.cssHeight });
    setPageLinks(cached.links);
    const pendingScroll = pendingPageScrollRef.current;
    if (pendingScroll) {
      pendingPageScrollRef.current = null;
      requestAnimationFrame(() => {
        if (sequence !== renderSequenceRef.current || currentPageRef.current !== page) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.scrollTo({
          top: pendingScroll === "bottom"
            ? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
            : 0,
          left: 0,
          behavior: "auto",
        });
      });
    }
    setRenderedPage(page);
    setRenderingPage(null);
  }, [fileName]);

  useEffect(() => {
    if (!documentProxy || viewportWidth <= 0) return;
    const sequence = ++renderSequenceRef.current;
    let cancelled = false;
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    setRenderingPage(currentPage);
    setError(null);

    const render = async () => {
      const page = await documentProxy.getPage(currentPage);
      if (cancelled || sequence !== renderSequenceRef.current) return;

      const baseViewport = page.getViewport({ scale: 1 });
      // Fit at zoom=1 uses every available horizontal pixel. This keeps the
      // document flush with both sides of the panel with no artificial gutter.
      const availableWidth = Math.max(120, viewportWidth);
      const cssScale = Math.max(0.1, (availableWidth / baseViewport.width) * zoom);
      const cssViewport = page.getViewport({ scale: cssScale });
      const cssWidth = cssViewport.width;
      const cssHeight = cssViewport.height;
      const preferredOutputScale = Math.min(window.devicePixelRatio || 1, 1.5);
      const pixelSafeScale = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, cssWidth * cssHeight));
      const outputScale = Math.max(0.1, Math.min(preferredOutputScale, pixelSafeScale));
      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const cacheKey = `${currentPage}:${Math.round(renderViewport.width)}x${Math.round(renderViewport.height)}`;
      const cached = pageCacheRef.current.get(cacheKey);
      if (cached) {
        pageCacheRef.current.delete(cacheKey);
        pageCacheRef.current.set(cacheKey, cached);
        commitCanvas(cached, currentPage, sequence);
        return;
      }

      const pageAnnotations = page.getAnnotations({ intent: "display" }).catch(() => [] as unknown[]);

      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = Math.max(1, Math.ceil(renderViewport.width));
      offscreenCanvas.height = Math.max(1, Math.ceil(renderViewport.height));
      offscreenCanvas.style.display = "block";
      offscreenCanvas.style.maxWidth = "none";
      offscreenCanvas.style.background = "#fff";
      const task = page.render({
        canvas: offscreenCanvas,
        viewport: renderViewport,
        background: "rgb(255,255,255)",
      });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
      if (cancelled || sequence !== renderSequenceRef.current) return;

      const links = makePageLinks(await pageAnnotations, cssViewport);
      if (cancelled || sequence !== renderSequenceRef.current) return;
      const rendered: CachedPage = { canvas: offscreenCanvas, cssWidth, cssHeight, links };
      pageCacheRef.current.set(cacheKey, rendered);
      let cachedPixels = Array.from(pageCacheRef.current.values()).reduce(
        (total, entry) => total + entry.canvas.width * entry.canvas.height,
        0,
      );
      while (
        pageCacheRef.current.size > 1
        && (pageCacheRef.current.size > PAGE_CACHE_LIMIT || cachedPixels > PAGE_CACHE_PIXEL_BUDGET)
      ) {
        const oldestKey = pageCacheRef.current.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldest = pageCacheRef.current.get(oldestKey);
        pageCacheRef.current.delete(oldestKey);
        if (oldest) {
          cachedPixels -= oldest.canvas.width * oldest.canvas.height;
          oldest.canvas.remove();
          oldest.canvas.width = 0;
          oldest.canvas.height = 0;
        }
      }
      page.cleanup();
      commitCanvas(rendered, currentPage, sequence);
    };

    void render().catch((renderError: unknown) => {
      if (cancelled || sequence !== renderSequenceRef.current || isRenderCancellation(renderError)) return;
      setRenderingPage(null);
      setError(renderError instanceof Error ? renderError.message : String(renderError));
    });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [commitCanvas, currentPage, documentProxy, viewportWidth, zoom]);

  const goToPage = useCallback((page: number, scrollTo: "top" | "bottom" = "top") => {
    const nextPage = clampPage(page, pageCount);
    pendingPageScrollRef.current = nextPage === currentPage ? null : scrollTo;
    setCurrentPage(nextPage);
    setPageInput(String(nextPage));
    if (nextPage === currentPage) {
      const viewport = viewportRef.current;
      viewport?.scrollTo({
        top: scrollTo === "bottom"
          ? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
          : 0,
        left: 0,
        behavior: "auto",
      });
    }
  }, [currentPage, pageCount]);

  const handleViewportWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    const viewport = event.currentTarget;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const direction: -1 | 1 = event.deltaY > 0 ? 1 : -1;
    const atBoundary = direction > 0
      ? viewport.scrollTop >= maxScrollTop - SCROLL_EDGE_EPSILON
      : viewport.scrollTop <= SCROLL_EDGE_EPSILON;
    const hasAdjacentPage = direction > 0 ? currentPage < pageCount : currentPage > 1;
    const gesture = wheelTurnRef.current;

    if (!atBoundary || !hasAdjacentPage) {
      gesture.direction = 0;
      gesture.distance = 0;
      return;
    }

    // Ignore wheel momentum while a different page is still being committed.
    if (renderedPage !== currentPage || (renderingPage !== null && renderingPage !== renderedPage)) {
      return;
    }

    const now = performance.now();
    if (now < gesture.cooldownUntil) return;
    if (gesture.direction !== direction || now - gesture.lastEventAt > WHEEL_GESTURE_RESET_MS) {
      gesture.direction = direction;
      gesture.distance = 0;
    }
    gesture.lastEventAt = now;

    let distance = Math.abs(event.deltaY);
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) distance *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) distance *= Math.max(1, viewport.clientHeight);
    gesture.distance += distance;
    if (gesture.distance < WHEEL_PAGE_TURN_THRESHOLD) return;

    gesture.distance = 0;
    gesture.cooldownUntil = now + WHEEL_PAGE_TURN_COOLDOWN_MS;
    goToPage(currentPage + direction, direction > 0 ? "top" : "bottom");
  }, [currentPage, goToPage, pageCount, renderedPage, renderingPage]);

  const pageFromScrubberPointer = useCallback((element: HTMLElement, clientY: number) => {
    if (pageCount <= 1) return 1;
    const rect = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return clampPage(1 + ratio * (pageCount - 1), pageCount);
  }, [pageCount]);

  const handleScrubberPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pageCount || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const page = pageFromScrubberPointer(event.currentTarget, event.clientY);
    setScrubPage(page);
  }, [pageCount, pageFromScrubberPointer]);

  const handleScrubberPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const page = pageFromScrubberPointer(event.currentTarget, event.clientY);
    setScrubPage(page);
  }, [pageFromScrubberPointer]);

  const finishScrubbing = useCallback((event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const page = pageFromScrubberPointer(event.currentTarget, event.clientY);
    setScrubPage(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit) goToPage(page);
  }, [goToPage, pageFromScrubberPointer]);

  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== "pan" || event.pointerType !== "mouse" || event.button !== 0 || renderedPage === null) return;
    const viewport = event.currentTarget;
    const rect = viewport.getBoundingClientRect();
    const verticalScrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
    const horizontalScrollbarHeight = viewport.offsetHeight - viewport.clientHeight;
    // Let the browser own pointer interaction inside its native scrollbar
    // gutters; capturing there would make the thumb impossible to drag.
    if (
      (verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth)
      || (horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight)
    ) return;

    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
      dragging: false,
    };
    viewport.setPointerCapture(event.pointerId);
  }, [renderedPage, tool]);

  const handleViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (!pan.dragging) {
      if (Math.hypot(deltaX, deltaY) < 3) return;
      pan.dragging = true;
      setIsPanning(true);
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = pan.startScrollLeft - deltaX;
    event.currentTarget.scrollTop = pan.startScrollTop - deltaY;
  }, []);

  const finishPanning = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const openPdfTarget = useCallback(async (
    dest: string | unknown[] | null,
    url: string | null,
  ) => {
    setOutlineOpen(false);
    setAnnotationMessage(null);
    if (dest && documentProxy) {
      try {
        const explicitDestination = typeof dest === "string"
          ? await documentProxy.getDestination(dest)
          : dest;
        const target = explicitDestination?.[0];
        let pageNumber: number | null = null;
        if (Number.isInteger(target)) {
          pageNumber = (target as number) + 1;
        } else if (
          typeof target === "object"
          && target !== null
          && "num" in target
          && "gen" in target
        ) {
          pageNumber = await documentProxy.getPageIndex(target as { num: number; gen: number }) + 1;
        }
        if (pageNumber !== null) {
          goToPage(pageNumber);
          return;
        }
      } catch (linkError) {
        setAnnotationMessage(`目录跳转失败：${linkError instanceof Error ? linkError.message : String(linkError)}`);
        return;
      }
    }

    if (url) {
      try {
        const targetUrl = new URL(url, window.location.href);
        if (!new Set(["http:", "https:", "mailto:"]).has(targetUrl.protocol)) {
          throw new Error("不支持的链接类型");
        }
        window.open(targetUrl.href, "_blank", "noopener,noreferrer");
      } catch (linkError) {
        setAnnotationMessage(`链接无法打开：${linkError instanceof Error ? linkError.message : String(linkError)}`);
      }
    }
  }, [documentProxy, goToPage]);

  const pointOnPage = useCallback((element: Element, clientX: number, clientY: number): PdfPoint => {
    const rect = element.getBoundingClientRect();
    return {
      x: clampUnit((clientX - rect.left) / Math.max(1, rect.width)),
      y: clampUnit((clientY - rect.top) / Math.max(1, rect.height)),
    };
  }, []);

  const handleInkPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (tool !== "ink" || event.button !== 0 || renderedSize?.page !== currentPage) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const points = [pointOnPage(event.currentTarget, event.clientX, event.clientY)];
    draftInkRef.current = points;
    setDraftInk(points);
    setAnnotationMessage(null);
  }, [currentPage, pointOnPage, renderedSize?.page, tool]);

  const handleInkPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !draftInkRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointOnPage(event.currentTarget, event.clientX, event.clientY);
    const previous = draftInkRef.current.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0015) return;
    const next = [...draftInkRef.current, point];
    draftInkRef.current = next;
    setDraftInk(next);
  }, [pointOnPage]);

  const finishInk = useCallback((event: ReactPointerEvent<SVGSVGElement>, commit: boolean) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    const points = draftInkRef.current;
    draftInkRef.current = null;
    setDraftInk(null);
    if (!commit || !points || points.length < 2) return;
    const annotation: PdfInkAnnotation = {
      id: annotationId(),
      type: "ink",
      page: currentPage,
      points,
      color: inkColor,
      width: inkWidth,
      createdAt: new Date().toISOString(),
    };
    setAnnotations((previous) => [...previous, annotation]);
  }, [currentPage, inkColor, inkWidth]);

  const addTextNote = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== "text" || event.button !== 0 || renderedSize?.page !== currentPage) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointOnPage(event.currentTarget, event.clientX, event.clientY);
    const width = 0.28;
    const height = 0.16;
    const annotation: PdfTextAnnotation = {
      id: annotationId(),
      type: "text",
      page: currentPage,
      x: Math.min(point.x, 1 - width),
      y: Math.min(point.y, 1 - height),
      width,
      height,
      text: "",
      createdAt: new Date().toISOString(),
    };
    setAnnotations((previous) => [...previous, annotation]);
    setEditingNoteId(annotation.id);
    setAnnotationMessage(null);
  }, [currentPage, pointOnPage, renderedSize?.page, tool]);

  const updateTextNote = useCallback((id: string, text: string) => {
    setAnnotations((previous) => previous.map((annotation) => (
      annotation.id === id && annotation.type === "text"
        ? { ...annotation, text: text.slice(0, 10_000) }
        : annotation
    )));
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((previous) => previous.filter((annotation) => annotation.id !== id));
    setEditingNoteId((current) => current === id ? null : current);
  }, []);

  const undoCurrentPage = useCallback(() => {
    setEditingNoteId(null);
    setAnnotations((previous) => {
      const index = previous.findLastIndex((annotation) => annotation.page === currentPage);
      return index < 0 ? previous : previous.filter((_, annotationIndex) => annotationIndex !== index);
    });
  }, [currentPage]);

  const clearCurrentPage = useCallback(async () => {
    if (!currentAnnotations.length || !await dialog.confirm({
      title: zh ? "清除页面标注" : "Clear page annotations",
      message: zh ? `清除第 ${currentPage} 页的全部标注吗？` : `Clear all annotations on page ${currentPage}?`,
      confirmLabel: zh ? "清除" : "Clear",
      danger: true,
    })) return;
    setAnnotations((previous) => previous.filter((annotation) => annotation.page !== currentPage));
    setEditingNoteId(null);
  }, [currentAnnotations.length, currentPage, dialog, zh]);

  const saveAnnotatedCopy = useCallback(async () => {
    if (savingCopy || !documentProxy) return;
    setSavingCopy(true);
    setAnnotationMessage(zh ? "正在生成带标注的 PDF…" : "Generating annotated PDF…");
    try {
      const response = await fetch(src, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`${zh ? "读取原 PDF 失败" : "Unable to read the original PDF"} (HTTP ${response.status})`);
      const bytes = await createAnnotatedPdf(await response.arrayBuffer(), annotations);
      const output = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      output.set(bytes);
      const blob = new Blob([output.buffer], { type: "application/pdf" });
      const saved = await saveBlobAs(blob, annotatedFileName(fileName));
      setAnnotationMessage(saved ? (zh ? "已另存为带标注的 PDF" : "Saved annotated PDF copy") : null);
    } catch (saveError) {
      setAnnotationMessage(`${zh ? "另存失败" : "Save failed"}: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    } finally {
      setSavingCopy(false);
    }
  }, [annotations, documentProxy, fileName, savingCopy, src, zh]);

  const commitPageInput = useCallback(() => {
    const parsed = Number(pageInput);
    if (Number.isFinite(parsed)) goToPage(parsed);
    else setPageInput(String(currentPage));
  }, [currentPage, goToPage, pageInput]);

  const nativeUrl = `${src}#page=${currentPage}`;
  const loading = !documentProxy && !error;
  const displayedScrubPage = scrubPage ?? currentPage;
  const scrubRatio = pageCount > 1 ? (displayedScrubPage - 1) / (pageCount - 1) : 0;

  return (
    <div
      style={{ position: "relative", display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden", background: "#d8dadd" }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        if (event.key === "Escape" && tool !== "pan") {
          event.preventDefault();
          setTool("pan");
          setDraftInk(null);
          draftInkRef.current = null;
          return;
        }
        if (event.key === "PageUp" || event.key === "ArrowLeft") {
          event.preventDefault();
          goToPage(currentPage - 1);
        } else if (event.key === "PageDown" || event.key === "ArrowRight") {
          event.preventDefault();
          goToPage(currentPage + 1);
        }
      }}
    >
      {!focusMode && <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 6,
        minHeight: 34,
        padding: "3px 36px 3px 8px",
        overflowX: "auto",
        overflowY: "hidden",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "#323639",
        color: "#f4f4f5",
        flexShrink: 0,
        fontSize: 12,
      }}>
          <button
            type="button"
            style={{
              ...controlButtonStyle,
              background: outlineOpen ? "var(--accent)" : controlButtonStyle.background,
              color: outlineOpen ? "#fff" : controlButtonStyle.color,
            }}
            disabled={outline.length === 0}
            onClick={() => setOutlineOpen((value) => !value)}
            title={outline.length ? (zh ? "PDF 目录" : "PDF outline") : (zh ? "此 PDF 没有目录" : "This PDF has no outline")}
            aria-label="PDF outline"
            aria-expanded={outlineOpen}
          >
            ☰
          </button>
          <button type="button" style={controlButtonStyle} disabled={currentPage <= 1 || loading} onClick={() => goToPage(currentPage - 1)} title={zh ? "上一页" : "Previous page"}>
            <ChevronIcon direction="left" />
          </button>
          <input
            aria-label={zh ? "PDF 页码" : "PDF page number"}
            value={pageInput}
            inputMode="numeric"
            onChange={(event) => setPageInput(event.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPageInput();
                event.currentTarget.blur();
              }
            }}
            style={{
              width: 50,
              height: 26,
              padding: "0 6px",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 4,
              background: "#202124",
              color: "#fff",
              textAlign: "center",
              outline: "none",
              fontSize: 12,
            }}
          />
          <span style={{ minWidth: 54, color: "rgba(255,255,255,0.72)" }}>/ {pageCount || "—"}</span>
          <button type="button" style={controlButtonStyle} disabled={!pageCount || currentPage >= pageCount || loading} onClick={() => goToPage(currentPage + 1)} title={zh ? "下一页" : "Next page"}>
            <ChevronIcon direction="right" />
          </button>
          <span style={{ width: 1, height: 20, margin: "0 3px", background: "rgba(255,255,255,0.13)" }} />
          <button type="button" style={controlButtonStyle} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))} title={zh ? "缩小" : "Zoom out"}>−</button>
          <span style={{ width: 42, textAlign: "center", color: "rgba(255,255,255,0.78)", fontVariantNumeric: "tabular-nums" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" style={controlButtonStyle} onClick={() => setZoom((value) => Math.min(3, Number((value + 0.1).toFixed(2))))} title={zh ? "放大" : "Zoom in"}>+</button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title={zh ? "适应面板宽度" : "Fit page to panel width"}
            style={{ ...controlButtonStyle, width: 42, marginLeft: 2, fontSize: 11, fontWeight: 600 }}
          >
            Fit
          </button>
          <span style={{ width: 1, height: 20, margin: "0 3px", background: "rgba(255,255,255,0.13)" }} />
          <button
            type="button"
            aria-pressed={tool === "ink"}
            onClick={() => {
              setTool((current) => current === "ink" ? "pan" : "ink");
              setEditingNoteId(null);
            }}
            title={zh ? "画笔标注" : "Draw annotation"}
            style={{
              ...controlButtonStyle,
              background: tool === "ink" ? "var(--accent)" : controlButtonStyle.background,
              color: tool === "ink" ? "#fff" : controlButtonStyle.color,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m14.5 4.5 5 5L8 21H3v-5Z" /><path d="m12 7 5 5" />
            </svg>
          </button>
          {tool === "ink" && (
            <>
              <input
                type="color"
                aria-label={zh ? "画笔颜色" : "Ink color"}
                value={inkColor}
                onChange={(event) => setInkColor(event.target.value)}
                style={{ width: 26, height: 26, padding: 2, border: "1px solid rgba(255,255,255,0.18)", borderRadius: 5, background: "transparent" }}
              />
              <input
                type="range"
                aria-label={zh ? "画笔粗细" : "Ink width"}
                min={1}
                max={10}
                value={inkWidth}
                onChange={(event) => setInkWidth(Number(event.target.value))}
                style={{ width: 54 }}
              />
            </>
          )}
          <button
            type="button"
            aria-pressed={tool === "text"}
            onClick={() => setTool((current) => current === "text" ? "pan" : "text")}
            title={zh ? "添加文字便签" : "Add text note"}
            style={{
              ...controlButtonStyle,
              background: tool === "text" ? "#d8b84b" : controlButtonStyle.background,
              color: tool === "text" ? "#27210d" : controlButtonStyle.color,
              fontWeight: 800,
            }}
          >
            T
          </button>
          <button type="button" style={controlButtonStyle} disabled={currentAnnotations.length === 0} onClick={undoCurrentPage} title={zh ? "撤销本页最后一条标注" : "Undo the last annotation on this page"}>
            ↶
          </button>
          <button type="button" style={controlButtonStyle} disabled={currentAnnotations.length === 0} onClick={clearCurrentPage} title={zh ? "清除本页全部标注" : "Clear all annotations on this page"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" />
            </svg>
          </button>
          <button
            type="button"
            disabled={savingCopy || loading}
            onClick={() => void saveAnnotatedCopy()}
            title={zh ? "另存为带标注的 PDF" : "Save a copy with annotations"}
            style={{ ...controlButtonStyle, width: 56, fontSize: 10, fontWeight: 700 }}
          >
            {savingCopy ? (zh ? "保存中" : "Saving") : (zh ? "另存为" : "Save as")}
          </button>
          {onFocusModeChange && (
            <button
              type="button"
              aria-label="Open PDF focus mode in the right panel"
              title="Fill the right panel"
              onClick={() => {
                setZoom(1);
                setTool("pan");
                setOutlineOpen(false);
                viewportRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
                onFocusModeChange(true);
              }}
              style={{ ...controlButtonStyle, width: 32, marginLeft: 2 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M8 21H3v-5" /><path d="M16 21h5v-5" />
              </svg>
            </button>
          )}
          <a
            href={nativeUrl}
            target="_blank"
            rel="noreferrer"
            title="Open in browser PDF viewer"
            style={{ ...controlButtonStyle, width: 34, marginLeft: 3, textDecoration: "none" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </a>
      </div>}

      {!focusMode && outlineOpen && (
        <div style={{
          position: "absolute",
          top: 34,
          left: 6,
          zIndex: 40,
          width: 310,
          maxWidth: "calc(100% - 30px)",
          maxHeight: "min(520px, calc(100% - 48px))",
          display: "flex",
          flexDirection: "column",
          padding: 8,
          overflow: "hidden",
          border: "1px solid var(--border)",
          borderRadius: "0 0 10px 10px",
          background: "var(--bg-panel)",
          boxShadow: "0 14px 36px rgba(0,0,0,0.22)",
        }}>
          <div style={{ display: "flex", alignItems: "center", padding: "2px 5px 7px", color: "var(--text)", fontSize: 12, fontWeight: 800 }}>
            PDF 目录
            <button type="button" onClick={() => setOutlineOpen(false)} aria-label="关闭 PDF 目录" style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <div style={{ minHeight: 0, overflowY: "auto" }}>
            <PdfOutlineTree items={outline} onActivate={(node) => void openPdfTarget(node.dest, node.url)} />
          </div>
        </div>
      )}

      {annotationMessage && (
        <div role="status" style={{
          position: "absolute",
          right: 28,
          bottom: 12,
          zIndex: 50,
          maxWidth: 360,
          padding: "7px 11px",
          borderRadius: 8,
          background: annotationMessage.startsWith("另存失败") || annotationMessage.includes("失败") ? "rgba(127,29,29,0.94)" : "rgba(32,33,36,0.92)",
          color: "#fff",
          fontSize: 11,
          boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
          pointerEvents: "none",
        }}>
          {annotationMessage}
        </div>
      )}

      <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div
          ref={viewportRef}
          className="pdf-canvas-viewport"
          title={renderedPage === null ? undefined : "Drag the page to pan"}
          onWheel={handleViewportWheel}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={finishPanning}
          onPointerCancel={finishPanning}
          onLostPointerCapture={() => {
            panRef.current = null;
            setIsPanning(false);
          }}
          onDragStart={(event) => event.preventDefault()}
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowX: "auto",
            overflowY: "scroll",
            scrollbarGutter: "stable",
            overscrollBehavior: "contain",
            padding: 0,
            cursor: renderedPage === null ? "default" : tool === "pan" ? isPanning ? "grabbing" : "grab" : "crosshair",
            userSelect: "none",
          }}
        >
          <div
            style={{
              position: "relative",
              width: "max-content",
              minWidth: "100%",
              minHeight: "100%",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
            }}
          >
            <div
              ref={pageSurfaceRef}
              style={{
                position: "relative",
                width: renderedSize?.width ?? 0,
                height: renderedSize?.height ?? 0,
                flexShrink: 0,
                background: "#fff",
              }}
            >
              <div ref={canvasHostRef} style={{ position: "absolute", inset: 0, zIndex: 0 }} />

              {renderedSize?.page === currentPage && pageLinks.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  aria-label="PDF 内部链接"
                  title={link.url ? "打开 PDF 链接" : "跳转到 PDF 目录目标"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void openPdfTarget(link.dest, link.url);
                  }}
                  style={{
                    position: "absolute",
                    zIndex: 1,
                    left: link.left,
                    top: link.top,
                    width: link.width,
                    height: link.height,
                    padding: 0,
                    border: "1px solid transparent",
                    background: "rgba(59,130,246,0.015)",
                    cursor: "pointer",
                  }}
                />
              ))}

              {renderedSize?.page === currentPage && (
                <svg
                  width={renderedSize.width}
                  height={renderedSize.height}
                  viewBox={`0 0 ${renderedSize.width} ${renderedSize.height}`}
                  onPointerDown={handleInkPointerDown}
                  onPointerMove={handleInkPointerMove}
                  onPointerUp={(event) => finishInk(event, true)}
                  onPointerCancel={(event) => finishInk(event, false)}
                  style={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 2,
                    pointerEvents: tool === "ink" ? "auto" : "none",
                    touchAction: "none",
                    overflow: "visible",
                  }}
                >
                  {currentAnnotations.filter((annotation): annotation is PdfInkAnnotation => annotation.type === "ink").map((annotation) => (
                    <polyline
                      key={annotation.id}
                      points={annotation.points.map((point) => `${point.x * renderedSize.width},${point.y * renderedSize.height}`).join(" ")}
                      fill="none"
                      stroke={annotation.color}
                      strokeWidth={annotation.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.92}
                    />
                  ))}
                  {draftInk && draftInk.length > 1 && (
                    <polyline
                      points={draftInk.map((point) => `${point.x * renderedSize.width},${point.y * renderedSize.height}`).join(" ")}
                      fill="none"
                      stroke={inkColor}
                      strokeWidth={inkWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={0.92}
                    />
                  )}
                </svg>
              )}

              {renderedSize?.page === currentPage && (
                <div
                  aria-label="在 PDF 页面添加文字便签"
                  onPointerDown={addTextNote}
                  style={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 3,
                    pointerEvents: tool === "text" ? "auto" : "none",
                    cursor: "crosshair",
                  }}
                />
              )}

              {renderedSize?.page === currentPage && currentAnnotations.filter((annotation): annotation is PdfTextAnnotation => annotation.type === "text").map((annotation) => (
                <div
                  key={annotation.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{
                    position: "absolute",
                    zIndex: 4,
                    left: `${annotation.x * 100}%`,
                    top: `${annotation.y * 100}%`,
                    width: `${annotation.width * 100}%`,
                    height: `${annotation.height * 100}%`,
                    minWidth: 90,
                    minHeight: 62,
                    padding: 7,
                    border: editingNoteId === annotation.id ? "2px solid #d8a900" : "1px solid #d8b84b",
                    borderRadius: 4,
                    background: "#fff4a8",
                    boxShadow: "0 3px 10px rgba(83,65,8,0.22)",
                    color: "#4a3d16",
                    boxSizing: "border-box",
                  }}
                >
                  <textarea
                    autoFocus={editingNoteId === annotation.id}
                    aria-label="PDF 文字便签"
                    value={annotation.text}
                    placeholder="输入笔记…"
                    onFocus={() => setEditingNoteId(annotation.id)}
                    onChange={(event) => updateTextNote(annotation.id, event.target.value)}
                    onBlur={() => setEditingNoteId((current) => current === annotation.id ? null : current)}
                    style={{
                      width: "100%",
                      height: "100%",
                      padding: "0 18px 0 0",
                      resize: "none",
                      border: "none",
                      outline: "none",
                      background: "transparent",
                      color: "inherit",
                      font: '12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                      boxSizing: "border-box",
                    }}
                  />
                  <button
                    type="button"
                    aria-label="删除便签"
                    title="删除便签"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => deleteAnnotation(annotation.id)}
                    style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "rgba(92,70,0,0.10)", color: "#705900", cursor: "pointer", lineHeight: "20px" }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {(loading || (renderingPage !== null && renderedPage === null)) && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 9, color: "#555", fontSize: 12, pointerEvents: "none" }}>
              <span style={{ width: 22, height: 22, border: "2px solid rgba(0,0,0,0.14)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span>{loading ? `Loading PDF${loadProgress === null ? "" : ` ${loadProgress}%`}` : `Rendering page ${renderingPage}`}</span>
            </div>
          )}

          {renderingPage !== null && renderedPage !== null && renderingPage !== renderedPage && (
            <div style={{ position: "sticky", left: "100%", bottom: 10, width: "max-content", marginLeft: "auto", padding: "5px 9px", borderRadius: 12, background: "rgba(32,33,36,0.82)", color: "#fff", fontSize: 11, pointerEvents: "none" }}>
              Page {renderingPage}…
            </div>
          )}

          {error && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg-panel)", color: "#f87171", fontSize: 13, textAlign: "center" }}>
              Failed to render PDF: {error}
            </div>
          )}
        </div>

        <div
          aria-label="PDF document page scrubber"
          title="Drag to jump through the whole PDF"
          style={{
            position: "relative",
            width: 18,
            flexShrink: 0,
            borderLeft: "1px solid rgba(0,0,0,0.18)",
            background: "#c6c8cb",
          }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="Current PDF page"
            aria-valuemin={1}
            aria-valuemax={pageCount || 1}
            aria-valuenow={displayedScrubPage}
            aria-valuetext={`Page ${displayedScrubPage} of ${pageCount || 1}`}
            onPointerDown={handleScrubberPointerDown}
            onPointerMove={handleScrubberPointerMove}
            onPointerUp={(event) => finishScrubbing(event, true)}
            onPointerCancel={(event) => finishScrubbing(event, false)}
            onLostPointerCapture={() => {
              setScrubPage(null);
            }}
            onKeyDown={(event) => {
              let nextPage: number | null = null;
              if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextPage = currentPage - 1;
              else if (event.key === "ArrowDown" || event.key === "ArrowRight") nextPage = currentPage + 1;
              else if (event.key === "PageUp") nextPage = currentPage - 10;
              else if (event.key === "PageDown") nextPage = currentPage + 10;
              else if (event.key === "Home") nextPage = 1;
              else if (event.key === "End") nextPage = pageCount;
              if (nextPage === null) return;
              event.preventDefault();
              event.stopPropagation();
              goToPage(nextPage);
            }}
            style={{
              position: "absolute",
              inset: "8px 3px",
              borderRadius: 6,
              background: "rgba(55,65,81,0.2)",
              cursor: "ns-resize",
              outlineOffset: 1,
              touchAction: "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: `${scrubRatio * 100}%`,
                left: 1,
                right: 1,
                height: 30,
                borderRadius: 5,
                transform: scrubRatio <= 0 ? "none" : scrubRatio >= 1 ? "translateY(-100%)" : "translateY(-50%)",
                background: scrubPage === null ? "#59616b" : "var(--accent)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                pointerEvents: "none",
              }}
            />
            {scrubPage !== null && (
              <span style={{
                position: "absolute",
                top: `${scrubRatio * 100}%`,
                right: 19,
                transform: scrubRatio <= 0 ? "none" : scrubRatio >= 1 ? "translateY(-100%)" : "translateY(-50%)",
                padding: "4px 7px",
                borderRadius: 5,
                background: "rgba(32,33,36,0.92)",
                color: "#fff",
                fontSize: 11,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}>
                {scrubPage} / {pageCount}
              </span>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
