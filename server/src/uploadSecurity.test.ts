import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertGlbMagic, assertSafeUploadName, assertUniqueUploadNames, isGlbPathname, UploadValidationError, uploadErrorResponse, validateUploadFile } from "./uploadSecurity.ts";

const file = (originalname: string, mimetype: string, size = 10) => ({ originalname, mimetype, size });
function rejects400(action: () => unknown, message?: string) {
  assert.throws(action, (error: unknown) => error instanceof UploadValidationError && error.statusCode === 400 && (!message || error.message === message));
}

test("upload whitelist rejects scripts and executables with 4xx metadata", () => {
  for (const [name, mime] of [["run.js", "application/javascript"], ["run.exe", "application/octet-stream"], ["run.ps1", "text/plain"], ["page.html", "text/html"], ["page.htm", "text/html"]]) {
    rejects400(() => validateUploadFile(file(name, mime), "resource-pack", "assets"));
  }
  rejects400(() => validateUploadFile(file("vector.svg", "image/svg+xml"), "resource-pack", "assets"));
  assert.equal(uploadErrorResponse(new UploadValidationError("不允许上传此类型文件：run.js")).statusCode, 400);
});

test("all current resource types and approved media pass the whitelist", () => {
  validateUploadFile(file("hider.glb", "model/gltf-binary"), "resource-pack", "assets");
  validateUploadFile(file("manifest.json", "application/json"), "resource-pack", "manifest");
  validateUploadFile(file("README.md", "text/markdown"), "resource-pack", "assets");
  validateUploadFile(file("texture.png", "image/png"), "resource-pack", "assets");
  validateUploadFile(file("texture.jpg", "image/jpeg"), "resource-pack", "assets");
  validateUploadFile(file("texture.webp", "image/webp"), "resource-pack", "assets");
  validateUploadFile(file("texture.avif", "image/avif"), "resource-pack", "assets");
  validateUploadFile(file("round.mp3", "audio/mpeg"), "resource-pack", "assets");
});

test("duplicate names and path traversal are rejected", () => {
  rejects400(() => assertSafeUploadName("../scene.glb"));
  rejects400(() => assertSafeUploadName("folder\\scene.glb"));
  rejects400(() => assertSafeUploadName(".."));
  rejects400(() => assertSafeUploadName("场景.glb"));
  rejects400(() => assertUniqueUploadNames([file("scene.glb", "model/gltf-binary"), file("SCENE.GLB", "model/gltf-binary")]));
});

test("real GLB magic bytes pass and renamed non-GLB files fail", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "drone-hide-upload-"));
  try {
    const invalid = path.join(root, "renamed.glb");
    writeFileSync(invalid, "this is not a model");
    const realGlb = fileURLToPath(new URL("../uploads/plugins/classroom-fps-demo-pack/hider.glb", import.meta.url));
    validateUploadFile(file("hider.glb", "model/gltf-binary", 2944), "map", "model");
    validateUploadFile(file("hider.glb", "model/gltf-binary", 2944), "map-package", "scene");
    validateUploadFile(file("hider.glb", "model/gltf-binary", 2944), "resource-pack", "assets");
    assert.doesNotThrow(() => assertGlbMagic(realGlb, "hider.glb"));
    validateUploadFile(file("renamed.glb", "model/gltf-binary", 19), "resource-pack", "assets");
    rejects400(() => assertGlbMagic(invalid, "renamed.glb"), "文件不是有效的 GLB 二进制模型：renamed.glb");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("map package accepts only GLB scene and approved texture thumbnail", () => {
  validateUploadFile(file("scene.glb", "application/octet-stream"), "map-package", "scene");
  validateUploadFile(file("thumbnail.avif", "image/avif"), "map-package", "thumbnail");
  rejects400(() => validateUploadFile(file("thumbnail.svg", "image/svg+xml"), "map-package", "thumbnail"));
});

test("per-type size limits and Multer file-size errors map to 413", () => {
  assert.throws(
    () => validateUploadFile(file("manifest.json", "application/json", 2 * 1024 * 1024 + 1), "resource-pack", "manifest"),
    (error: unknown) => error instanceof UploadValidationError && error.statusCode === 413,
  );
  assert.deepEqual(uploadErrorResponse({ code: "LIMIT_FILE_SIZE" }), { statusCode: 413, message: "文件超过允许大小上限" });
  assert.deepEqual(uploadErrorResponse({ code: "LIMIT_UNEXPECTED_FILE" }), { statusCode: 400, message: "上传字段或文件数量不符合接口要求" });
});

test("remote map extension is checked against pathname only", () => {
  assert.equal(isGlbPathname(new URL("https://example.test/map.glb?download=1#preview").pathname), true);
  assert.equal(isGlbPathname(new URL("https://example.test/map.glb.exe?file=.glb").pathname), false);
  assert.equal(isGlbPathname(new URL("https://example.test/download?file=map.glb").pathname), false);
});

