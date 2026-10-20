import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

export type UploadRoute = "map" | "map-package" | "resource-pack";
export type UploadField = "model" | "manifest" | "scene" | "collision" | "thumbnail" | "assets";

export interface UploadCandidate {
  originalname: string;
  mimetype: string;
  size: number;
}

export class UploadValidationError extends Error {
  readonly statusCode: 400 | 413;

  constructor(message: string, statusCode: 400 | 413 = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.statusCode = statusCode;
  }
}

const MIME_BY_EXTENSION: Record<string, Set<string>> = {
  ".glb": new Set(["model/gltf-binary", "application/octet-stream"]),
  ".gltf": new Set(["model/gltf+json", "application/json"]),
  ".bin": new Set(["application/octet-stream"]),
  ".json": new Set(["application/json", "text/json"]),
  ".png": new Set(["image/png"]),
  ".jpg": new Set(["image/jpeg"]),
  ".jpeg": new Set(["image/jpeg"]),
  ".webp": new Set(["image/webp"]),
  ".avif": new Set(["image/avif"]),
  ".mp3": new Set(["audio/mpeg"]),
  ".wav": new Set(["audio/wav", "audio/x-wav"]),
  ".ogg": new Set(["audio/ogg"]),
  ".m4a": new Set(["audio/mp4"]),
  ".md": new Set(["text/markdown", "text/plain"]),
};

const SIZE_BY_EXTENSION: Record<string, number> = {
  ".glb": 100 * 1024 * 1024,
  ".gltf": 100 * 1024 * 1024,
  ".bin": 100 * 1024 * 1024,
  ".json": 2 * 1024 * 1024,
  ".png": 20 * 1024 * 1024,
  ".jpg": 20 * 1024 * 1024,
  ".jpeg": 20 * 1024 * 1024,
  ".webp": 20 * 1024 * 1024,
  ".avif": 20 * 1024 * 1024,
  ".mp3": 50 * 1024 * 1024,
  ".wav": 100 * 1024 * 1024,
  ".ogg": 50 * 1024 * 1024,
  ".m4a": 50 * 1024 * 1024,
  ".md": 1 * 1024 * 1024,
};

function allowedExtensions(route: UploadRoute, field: UploadField) {
  if (route === "map" && field === "model") return new Set([".glb"]);
  if (route === "map-package") {
    if (field === "manifest") return new Set([".json"]);
    if (field === "scene" || field === "collision") return new Set([".glb"]);
    if (field === "thumbnail") return new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
    return new Set<string>();
  }
  if (field === "manifest") return new Set([".json"]);
  if (field === "assets") return new Set(Object.keys(MIME_BY_EXTENSION));
  return new Set<string>();
}

export function fileExtension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

export function validateUploadType(file: Pick<UploadCandidate, "originalname" | "mimetype">, route: UploadRoute, field: UploadField) {
  const extension = fileExtension(file.originalname);
  const allowed = allowedExtensions(route, field);
  if (!allowed.has(extension)) {
    throw new UploadValidationError(`不允许上传此类型文件：${file.originalname}`);
  }
  const allowedMime = MIME_BY_EXTENSION[extension];
  if (!allowedMime?.has(file.mimetype.toLowerCase())) {
    throw new UploadValidationError(`文件 MIME 类型与扩展名不匹配：${file.originalname}`);
  }
}

export function validateUploadFile(file: UploadCandidate, route: UploadRoute, field: UploadField) {
  validateUploadType(file, route, field);
  const extension = fileExtension(file.originalname);
  const maxSize = SIZE_BY_EXTENSION[extension];
  if (file.size > maxSize) {
    throw new UploadValidationError(`文件超过允许大小上限：${file.originalname}`, 413);
  }
}

export function assertSafeUploadName(fileName: string) {
  if (!fileName || fileName === "." || fileName === ".." || path.isAbsolute(fileName) || /[\\/]/.test(fileName) || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new UploadValidationError("文件名必须是 ASCII 安全文件名，且不能包含目录路径");
  }
  return fileName;
}

export function assertUniqueUploadNames(files: Array<Pick<UploadCandidate, "originalname">>) {
  const names = new Set<string>();
  for (const file of files) {
    assertSafeUploadName(file.originalname);
    const normalized = file.originalname.toLowerCase();
    if (names.has(normalized)) throw new UploadValidationError(`上传文件名重复：${file.originalname}`);
    names.add(normalized);
  }
}

export function assertGlbMagic(filePath: string, fileName: string) {
  const fd = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead !== 4 || header.toString("ascii") !== "glTF") {
      throw new UploadValidationError(`文件不是有效的 GLB 二进制模型：${fileName}`);
    }
  } finally {
    closeSync(fd);
  }
}

export function isGlbPathname(pathname: string) {
  return /\.glb$/i.test(pathname);
}

export function isMulterSizeError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "LIMIT_FILE_SIZE";
}

export function uploadErrorResponse(error: unknown) {
  if (isMulterSizeError(error)) return { statusCode: 413, message: "文件超过允许大小上限" } as const;
  if (typeof error === "object" && error !== null && "code" in error && String((error as { code?: unknown }).code).startsWith("LIMIT_")) {
    return { statusCode: 400, message: "上传字段或文件数量不符合接口要求" } as const;
  }
  if (error instanceof UploadValidationError) return { statusCode: error.statusCode, message: error.message } as const;
  return { statusCode: 400, message: error instanceof Error ? error.message : "上传数据格式无效" } as const;
}

