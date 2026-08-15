// Document outline: click a heading to jump to it.
//
// Two data sources, by mode:
//   * rich (wysiwyg/ir): `headings` — extracted from the LIVE ProseMirror doc
//     by useMilkdown, whose ids are Milkdown's own <hN id>s, so jumps always
//     resolve. Emitted only on real heading changes (stable array ref).
//   * sv: the hidden ProseMirror doc is stale while the textarea is edited, so
//     the outline re-parses `markdown` (line numbers recorded for jumps).
//
// Performance: React.memo'd so it only re-renders when props actually change.
// The sv source is debounced then deferred so a fast typist in a large document
// doesn't block the main thread on every keystroke.

import { memo, useDeferredValue, useMemo } from "react";
import { buildOutline, buildOutlineFromHeadings } from "../lib/outline";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { EditMode, FlatHeading, OutlineNode } from "../types";

interface Props {
  mode: EditMode;
  /** Live markdown source (sv-mode outline + editor-not-ready fallback). */
  markdown: string;
  /** Live doc headings (rich mode); null until the editor reports them. */
  headings: FlatHeading[] | null;
  onJump: (node: OutlineNode) => void;
}

export const Outline = memo(function Outline({
  mode,
  markdown,
  headings,
  onJump,
}: Props) {
  // T5: debounce the sv source first so a typing burst collapses into ONE
  // reparse, then defer it so even that single recompute doesn't compete with
  // typing. The doc-derived path arrives already change-gated from the editor,
  // but running it through the same defer costs nothing.
  const debouncedMd = useDebouncedValue(markdown, 150);
  const deferredMd = useDeferredValue(debouncedMd);
  const deferredHeadings = useDeferredValue(headings);
  const tree = useMemo(
    () =>
      mode === "sv" || deferredHeadings == null
        ? buildOutline(deferredMd)
        : buildOutlineFromHeadings(deferredHeadings),
    [mode, deferredMd, deferredHeadings]
  );
  if (tree.length === 0) {
    return <div className="ol-empty">无标题</div>;
  }
  return (
    <ul className="ol-root">
      {tree.map((n) => (
        <OutlineItem key={n.id} node={n} onJump={onJump} />
      ))}
    </ul>
  );
});

const OutlineItem = memo(function OutlineItem({
  node,
  onJump,
}: {
  node: OutlineNode;
  onJump: (node: OutlineNode) => void;
}) {
  return (
    <li>
      <div
        className={`ol-row ol-h${node.level}`}
        title={node.text}
        onClick={() => onJump(node)}
      >
        {node.text}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <OutlineItem key={c.id} node={c} onJump={onJump} />
          ))}
        </ul>
      )}
    </li>
  );
});
