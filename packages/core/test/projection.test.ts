/**
 * 投影清单的尺子。
 *
 * 清单的唯一用途是决定"哪些旧文件可以删"，所以它的失败方向必须偏向**不删**：
 * 读不懂就返回 null，路径可疑就整份拒绝。一个"尽量恢复"的解析器
 * 会删掉不该删的文件，而那不是可回滚的错误。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECTION_MANIFEST,
  generatedPathsOf,
  stalePaths,
  withProjectionManifest,
} from "../src/projection.ts";

test("加上清单：文件按路径排序，清单在，而且把自己也列进去", () => {
  const files = withProjectionManifest("test", [
    { path: "b.txt", content: "b" },
    { path: "a.txt", content: "a" },
  ]);
  assert.deepEqual(
    files.map((file) => file.path),
    [PROJECTION_MANIFEST, "a.txt", "b.txt"],
  );
  const manifest = files.find((file) => file.path === PROJECTION_MANIFEST);
  assert.ok(manifest !== undefined);
  const paths = generatedPathsOf(JSON.parse(manifest.content));
  assert.deepEqual(paths, [PROJECTION_MANIFEST, "a.txt", "b.txt"]);
});

test("清单的字节是确定的：输入顺序不影响输出", () => {
  const a = withProjectionManifest("test", [
    { path: "b.txt", content: "b" },
    { path: "a.txt", content: "a" },
  ]);
  const b = withProjectionManifest("test", [
    { path: "a.txt", content: "a" },
    { path: "b.txt", content: "b" },
  ]);
  assert.deepEqual(a, b);
});

test("stalePaths：只报上一份有、这一份没有的路径", () => {
  const files = [{ path: "a.txt", content: "a" }];
  assert.deepEqual(stalePaths(["a.txt", "old.txt"], files), ["old.txt"]);
  assert.deepEqual(stalePaths(null, files), [], "读不懂清单时不许删任何东西");
});

test("可疑路径整份拒绝（不删比误删好）", () => {
  for (const path of ["../x", "/x", "a\\b", "", "a//b", "./a"]) {
    assert.equal(generatedPathsOf({ files: [path] }), null, `应当拒绝 ${JSON.stringify(path)}`);
  }
  const mixed = generatedPathsOf({ files: ["ok.md", "../escape.md"] });
  assert.equal(mixed, null, "只要有一条可疑，整份清单都不可信");
});
