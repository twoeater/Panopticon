import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  lstat,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class LocalFiles {
  root: string;
  constructor(root: string) {
    this.root = path.resolve(root, "profiles");
  }
  async folder(profile: string, channel?: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile))
      throw new Error("잘못된 참가자 ID");
    await mkdir(this.root, { recursive: true });
    const base = await realpath(this.root);
    const segments =
      channel === undefined ? [profile] : [profile, "channels", hash(channel)];
    let current = base;
    for (const segment of segments) {
      current = path.join(current, segment);
      await mkdir(current, { recursive: true });
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("프로필 폴더의 링크는 허용하지 않습니다.");
      const resolved = await realpath(current);
      if (
        path.relative(base, resolved).startsWith("..") ||
        path.isAbsolute(path.relative(base, resolved))
      )
        throw new Error("프로필 경로를 벗어났습니다.");
    }
    return current;
  }
  async read(
    profile: string,
    name: "Persona.md" | "Situation.md" | "Memory.md",
    channel?: string,
  ) {
    const dir = await this.folder(
        profile,
        name === "Memory.md" ? channel : undefined,
      ),
      file = path.join(dir, name);
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32768)
        throw new Error(`${name}: 일반 파일과 최대 32KiB만 지원합니다.`);
      const markdown = await readFile(file, "utf8");
      return { markdown, revision: hash(markdown) };
    } catch (error: any) {
      if (error.code === "ENOENT") return { markdown: "", revision: hash("") };
      throw error;
    }
  }
  async initialize(profile: string) {
    const dir = await this.folder(profile);
    for (const name of ["Persona.md", "Situation.md"] as const) {
      try {
        await writeFile(
          path.join(dir, name),
          name === "Persona.md"
            ? "# 성격\n\n자신만의 말투와 관점으로 대화하세요. 확실하지 않은 사실은 구분해 말하세요.\n"
            : "# 개인 상황\n\n",
          { flag: "wx" },
        );
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  async updateMemory(
    profile: string,
    channel: string,
    markdown: string,
    expectedRevision: string,
  ) {
    if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 32768)
      throw new Error("기억은 최대 32KiB입니다.");
    const dir = await this.folder(profile, channel),
      lock = path.join(dir, ".memory.lock");
    let handle;
    try {
      handle = await import("node:fs/promises").then((fs) =>
        fs.open(lock, "wx"),
      );
    } catch {
      throw new Error("기억 파일을 다른 작업이 수정 중입니다.");
    }
    try {
      const current = await this.read(profile, "Memory.md", channel);
      if (current.revision !== expectedRevision)
        throw new Error(
          "기억이 변경되었습니다. memory_read 후 다시 수정하세요.",
        );
      const historyDir = path.join(dir, "history");
      await mkdir(historyDir, { recursive: true });
      if ((await lstat(historyDir)).isSymbolicLink())
        throw new Error("기록 폴더의 링크는 허용하지 않습니다.");
      await writeFile(
        path.join(historyDir, `${Date.now()}-${randomUUID()}.md`),
        current.markdown,
        { flag: "wx" },
      );
      const temporary = path.join(dir, `.Memory-${randomUUID()}.tmp`);
      await writeFile(temporary, markdown, { flag: "wx" });
      await rename(temporary, path.join(dir, "Memory.md"));
      return { revision: hash(markdown) };
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
  async history(profile: string, channel: string) {
    const dir = path.join(await this.folder(profile, channel), "history");
    try {
      return (await readdir(dir))
        .filter((x) => /^\d+-[a-f0-9-]+\.md$/.test(x))
        .sort()
        .reverse();
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async restore(profile: string, channel: string, revisionFile: string) {
    if (!/^\d+-[a-f0-9-]+\.md$/.test(revisionFile))
      throw new Error("잘못된 기록 파일명");
    const dir = await this.folder(profile, channel);
    const file = path.join(dir, "history", revisionFile);
    if (
      (await lstat(path.join(dir, "history"))).isSymbolicLink() ||
      (await lstat(file)).isSymbolicLink()
    )
      throw new Error("링크는 허용하지 않습니다.");
    const content = await readFile(file, "utf8");
    const current = await this.read(profile, "Memory.md", channel);
    return this.updateMemory(profile, channel, content, current.revision);
  }
}
