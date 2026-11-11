import React from "react";
import { useEditor } from "./store.js";

export function ProposalsBar(): React.ReactElement | null {
  const proposals = useEditor((s) => s.proposals);
  const accept = useEditor((s) => s.acceptProposal);
  const reject = useEditor((s) => s.rejectProposal);
  if (!proposals.length) return null;
  const p = proposals[0]!;
  return (
    <div className="pb-root">
      <span className="pb-badge">AI</span>
      <span className="pb-text"><b>{p.label}</b> — {p.rationale} ({p.ops.length} ops)</span>
      <button className="pb-ok" onClick={() => accept(p.id)}>Accept</button>
      <button onClick={() => reject(p.id)}>Reject</button>
      {proposals.length > 1 && <span className="pb-more">+{proposals.length - 1} more</span>}
    </div>
  );
}
