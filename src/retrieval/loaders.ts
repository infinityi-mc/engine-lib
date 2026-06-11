import type { EngineContext } from "../runtime/types";
import type {
  DocumentLoader,
  DocumentLoaderOutput,
  LoadDocumentsResult,
  LoadedDocument,
} from "./types";
import { throwIfAborted } from "./utils";

function isAsyncIterable(value: DocumentLoaderOutput): value is AsyncIterable<LoadedDocument> {
  return Symbol.asyncIterator in Object(value);
}

function isIterable(value: DocumentLoaderOutput): value is Iterable<LoadedDocument> {
  return Symbol.iterator in Object(value);
}

async function collect(output: DocumentLoaderOutput, ctx?: EngineContext): Promise<LoadedDocument[]> {
  const documents: LoadedDocument[] = [];
  if (isAsyncIterable(output)) {
    for await (const document of output) {
      throwIfAborted(ctx);
      documents.push(document);
    }
    return documents;
  }
  if (isIterable(output)) {
    for (const document of output) {
      throwIfAborted(ctx);
      documents.push(document);
    }
    return documents;
  }
  return documents;
}

/** Build a document loader from a host-supplied load function. */
export function createDocumentLoader(
  name: string,
  load: (ctx?: EngineContext) => DocumentLoaderOutput | Promise<DocumentLoaderOutput>,
): DocumentLoader {
  return { name, load };
}

/** A deterministic in-memory loader useful for examples and tests. */
export function staticDocumentLoader(
  documents: readonly LoadedDocument[],
  name = "static-documents",
): DocumentLoader {
  return createDocumentLoader(name, () => documents.map((document) => ({ ...document })));
}

/** Load and normalize documents from all loaders in declaration order. */
export async function loadDocuments(
  loaders: readonly DocumentLoader[],
  ctx?: EngineContext,
): Promise<LoadDocumentsResult> {
  const documents: LoadedDocument[] = [];
  for (const loader of loaders) {
    throwIfAborted(ctx);
    const output = await loader.load(ctx);
    const loaded = await collect(output, ctx);
    documents.push(...loaded);
  }
  return { documents, loaders: loaders.length };
}
