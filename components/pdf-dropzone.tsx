"use client";

import * as React from "react";
import { FileUp } from "lucide-react";
import { cn } from "@/lib/utils";

// Phase 1 — UI only, no upload wiring yet. The signed-URL handshake to
// /api/upload comes in Phase 2 (BUILD_PLAN.md).
export function PdfDropzone() {
  const [dragOver, setDragOver] = React.useState(false);
  const [staged, setStaged] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function pickFile(file?: File | null) {
    if (!file) return;
    if (file.type !== "application/pdf") return;
    setStaged(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        pickFile(e.dataTransfer.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "border-border bg-card hover:bg-accent/30 flex h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed transition-colors",
        dragOver && "border-foreground/40 bg-accent/50",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
      <FileUp className="text-muted-foreground size-8" strokeWidth={1.5} />
      {staged ? (
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium">{staged.name}</span>
          <span className="text-muted-foreground text-xs">
            {(staged.size / 1024 / 1024).toFixed(2)} MB · staged (upload wires up in Phase 2)
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium">Drop a sprinkler plan PDF</span>
          <span className="text-muted-foreground text-xs">or click to browse</span>
        </div>
      )}
    </div>
  );
}
