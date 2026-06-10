import { lstat } from "node:fs/promises";
import { extname } from "node:path";

import type { FilesystemPolicy } from "./policy";
import { displayPath, resolvePath, resolveRoot } from "./policy";
import { listEntries, lineOffsets, readTextFile } from "./files";
import type { SymbolInfo, SymbolKind } from "./types";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function wanted(kind: SymbolKind, kinds: readonly SymbolKind[] | undefined): boolean {
  return kinds === undefined || kinds.length === 0 || kinds.includes(kind);
}

function lineRangeFromText(text: string, start: number, end: number): { startLine: number; endLine: number } {
  const beforeStart = text.slice(0, start);
  const beforeEnd = text.slice(0, end);
  return {
    startLine: beforeStart.split(/\r\n|\r|\n/).length,
    endLine: beforeEnd.split(/\r\n|\r|\n/).length,
  };
}

function regexSymbols(text: string, path: string, kinds?: readonly SymbolKind[]): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const lines = lineOffsets(text);
  const patterns: Array<{ kind: SymbolKind; regex: RegExp; nameIndex: number }> = [
    { kind: "import", regex: /^\s*import\s+(?:type\s+)?(?:.+?\s+from\s+)?["']([^"']+)["']/gm, nameIndex: 1 },
    { kind: "export", regex: /^\s*export\s+(?:default\s+)?(?:\{[^}]+\}|(?:class|function|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)?)/gm, nameIndex: 1 },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, nameIndex: 1 },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, nameIndex: 1 },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, nameIndex: 1 },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/gm, nameIndex: 1 },
    { kind: "variable", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, nameIndex: 1 },
  ];

  for (const { kind, regex, nameIndex } of patterns) {
    if (!wanted(kind, kinds)) continue;
    for (const match of text.matchAll(regex)) {
      const name = match[nameIndex] ?? match[0].trim();
      const range = lineRangeFromText(text, match.index ?? 0, (match.index ?? 0) + match[0].length);
      results.push({
        path,
        name,
        kind,
        startLine: range.startLine,
        endLine: range.endLine,
        signature: lines[range.startLine - 1]?.trim(),
      });
    }
  }
  return results.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
}

async function typescriptSymbols(text: string, path: string, kinds?: readonly SymbolKind[]): Promise<SymbolInfo[]> {
  if (!TS_EXTENSIONS.has(extname(path).toLowerCase())) return regexSymbols(text, path, kinds);
  try {
    const ts = await import("typescript");
    const scriptKind = extname(path).toLowerCase().includes("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
    const lines = lineOffsets(text);
    const out: SymbolInfo[] = [];

    const emit = (node: import("typescript").Node, kind: SymbolKind, name: string) => {
      if (!wanted(kind, kinds)) return;
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      out.push({
        path,
        name,
        kind,
        startLine: start,
        endLine: end,
        signature: lines[start - 1]?.trim(),
      });
    };

    const exported = (node: import("typescript").Node): boolean => {
      return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    };

    const visit = (node: import("typescript").Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        emit(node, "import", node.moduleSpecifier.text);
      } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
        emit(node, "class", node.name.text);
        if (exported(node)) emit(node, "export", node.name.text);
      } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        emit(node, "function", node.name.text);
        if (exported(node)) emit(node, "export", node.name.text);
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        emit(node, "method", node.name.text);
      } else if (ts.isInterfaceDeclaration(node)) {
        emit(node, "interface", node.name.text);
        if (exported(node)) emit(node, "export", node.name.text);
      } else if (ts.isTypeAliasDeclaration(node)) {
        emit(node, "type", node.name.text);
        if (exported(node)) emit(node, "export", node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            emit(declaration, "variable", declaration.name.text);
            if (exported(node)) emit(declaration, "export", declaration.name.text);
          }
        }
      } else if (ts.isExportDeclaration(node)) {
        const moduleName = node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : "export";
        emit(node, "export", moduleName);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
  } catch {
    return regexSymbols(text, path, kinds);
  }
}

export async function symbolsForFile(
  absPath: string,
  root: string,
  maxBytes: number,
  kinds?: readonly SymbolKind[],
): Promise<SymbolInfo[]> {
  const text = (await readTextFile(absPath, maxBytes)).text;
  return typescriptSymbols(text, displayPath(root, absPath), kinds);
}

export async function symbolsForPath(
  policy: FilesystemPolicy,
  input: string,
  options: {
    readonly recursive?: boolean;
    readonly kinds?: readonly SymbolKind[];
    readonly maxResults?: number;
  } = {},
): Promise<{ readonly results: SymbolInfo[]; readonly truncated: boolean; readonly root: string }> {
  const resolved = await resolvePath(policy, input, { mustExist: true });
  const info = await lstat(resolved.path);
  const maxResults = options.maxResults ?? 200;

  if (info.isDirectory()) {
    if (options.recursive !== true) {
      return { results: [], truncated: false, root: resolved.path };
    }
    const root = await resolveRoot(policy, input);
    const listed = await listEntries(root.path, {
      onlyFiles: true,
      respectGitignore: true,
      maxEntries: maxResults * 4,
    });
    const out: SymbolInfo[] = [];
    for (const entry of listed.entries) {
      if (!TS_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
      out.push(...await symbolsForFile(entry.path, root.path, policy.maxReadBytes, options.kinds));
      if (out.length >= maxResults) break;
    }
    return { results: out.slice(0, maxResults), truncated: listed.truncated || out.length > maxResults, root: root.path };
  }

  const results = await symbolsForFile(resolved.path, resolved.root, policy.maxReadBytes, options.kinds);
  return { results: results.slice(0, maxResults), truncated: results.length > maxResults, root: resolved.root };
}
