// Document outline: headings extracted from the live markdown, click to jump.
//
// Performance: React.memo'd so it only re-renders when `markdown`/`onJump`
// actually change. The outline is computed from a DEFERRED copy of the
// markdown so a fast typist in a large document doesn't block the main thread
// on every keystroke — React runs the recompute at lower priority.

import { memo, useDeferredValue, useMemo } from "react";
import { buildOutline } from "../lib/outline";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { OutlineNode } from "../types";

interface Props {
  markdown: string;
  onJump: (anchorId: string) => void;
}

export const Outline = memo(function Outline({ markdown, onJump }: Props) {
  // T5: debounce the source first so a typing burst collapses into ONE reparse,
  // then defer it so even that single recompute doesn't compete with typing.
  // Together this cuts the full-document outline parse from per-keystroke to
  // once-per-pause while staying non-blocking and eventually consistent.
  const debouncedMd = useDebouncedValue(markdown, 150);
  const deferredMd = useDeferredValue(debouncedMd);
  const tree = useMemo(() => buildOutline(deferredMd), [deferredMd]);
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
  onJump: (id: string) => void;
}) {
  return (
    <li>
      <div
        className={`ol-row ol-h${node.level}`}
        title={node.text}
        onClick={() => onJump(node.id)}
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
