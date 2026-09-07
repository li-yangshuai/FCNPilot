export interface PdfPoint {
  x: number;
  y: number;
}

export interface PdfInkAnnotation {
  id: string;
  type: "ink";
  page: number;
  points: PdfPoint[];
  color: string;
  width: number;
  createdAt: string;
}

export interface PdfTextAnnotation {
  id: string;
  type: "text";
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  createdAt: string;
}

export type PdfAnnotation = PdfInkAnnotation | PdfTextAnnotation;

const MAX_ANNOTATIONS = 5_000;
const MAX_INK_POINTS = 20_000;
const MAX_NOTE_LENGTH = 10_000;

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validBase(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAnnotation(value: unknown): PdfAnnotation | null {
  if (
    !validBase(value)
    || typeof value.id !== "string"
    || value.id.length > 200
    || !Number.isInteger(value.page)
    || (value.page as number) < 1
    || typeof value.createdAt !== "string"
  ) return null;

  if (value.type === "ink") {
    if (
      !Array.isArray(value.points)
      || value.points.length < 2
      || value.points.length > MAX_INK_POINTS
      || typeof value.color !== "string"
      || !/^#[0-9a-f]{6}$/i.test(value.color)
      || typeof value.width !== "number"
      || !Number.isFinite(value.width)
      || value.width < 0.5
      || value.width > 24
    ) return null;
    const points = value.points.filter((point): point is PdfPoint => (
      validBase(point) && finiteUnit(point.x) && finiteUnit(point.y)
    ));
    if (points.length !== value.points.length) return null;
    return {
      id: value.id,
      type: "ink",
      page: value.page as number,
      points,
      color: value.color,
      width: value.width,
      createdAt: value.createdAt,
    };
  }

  if (
    value.type === "text"
    && finiteUnit(value.x)
    && finiteUnit(value.y)
    && finiteUnit(value.width)
    && finiteUnit(value.height)
    && value.width > 0
    && value.height > 0
    && typeof value.text === "string"
    && value.text.length <= MAX_NOTE_LENGTH
  ) {
    return {
      id: value.id,
      type: "text",
      page: value.page as number,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      text: value.text,
      createdAt: value.createdAt,
    };
  }

  return null;
}

export function parsePdfAnnotations(value: unknown): PdfAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ANNOTATIONS)
    .map(normalizeAnnotation)
    .filter((annotation): annotation is PdfAnnotation => annotation !== null);
}

function hexToRgb(color: string): { red: number; green: number; blue: number } {
  return {
    red: Number.parseInt(color.slice(1, 3), 16) / 255,
    green: Number.parseInt(color.slice(3, 5), 16) / 255,
    blue: Number.parseInt(color.slice(5, 7), 16) / 255,
  };
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (lines.length >= maxLines) break;
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        if (lines.length >= maxLines) break;
        line = character.trimStart();
      } else {
        line = candidate;
      }
    }
    if (lines.length >= maxLines) break;
    if (line) lines.push(line);
  }
  if (lines.length === maxLines && context.measureText(lines[maxLines - 1]).width > maxWidth - 16) {
    let last = lines[maxLines - 1];
    while (last && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

async function renderStickyNotePng(text: string): Promise<ArrayBuffer> {
  const scale = 3;
  const width = 240;
  const height = 150;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.scale(scale, scale);
  context.fillStyle = "#fff4a8";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#d8b84b";
  context.lineWidth = 1.5;
  context.strokeRect(0.75, 0.75, width - 1.5, height - 1.5);
  context.fillStyle = "#4a3d16";
  context.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif';
  context.textBaseline = "top";
  const lines = wrapCanvasText(context, text, width - 24, 7);
  lines.forEach((line, index) => context.fillText(line, 12, 12 + index * 19));

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Unable to render note")), "image/png");
  });
  return blob.arrayBuffer();
}

export async function createAnnotatedPdf(
  original: ArrayBuffer,
  annotations: PdfAnnotation[],
): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const pages = pdf.getPages();

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1];
    if (!page) continue;
    const { width: pageWidth, height: pageHeight } = page.getSize();

    if (annotation.type === "ink") {
      const color = hexToRgb(annotation.color);
      const thickness = Math.max(0.5, annotation.width * pageWidth / 800);
      for (let index = 1; index < annotation.points.length; index += 1) {
        const start = annotation.points[index - 1];
        const end = annotation.points[index];
        page.drawLine({
          start: { x: start.x * pageWidth, y: (1 - start.y) * pageHeight },
          end: { x: end.x * pageWidth, y: (1 - end.y) * pageHeight },
          thickness,
          color: rgb(color.red, color.green, color.blue),
          opacity: 0.92,
        });
      }
      continue;
    }

    if (!annotation.text.trim()) continue;
    const noteImage = await pdf.embedPng(await renderStickyNotePng(annotation.text));
    page.drawImage(noteImage, {
      x: annotation.x * pageWidth,
      y: (1 - annotation.y - annotation.height) * pageHeight,
      width: annotation.width * pageWidth,
      height: annotation.height * pageHeight,
    });
  }

  return pdf.save();
}
