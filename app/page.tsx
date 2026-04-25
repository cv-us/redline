import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ProjectSwitcher } from "@/components/project-switcher";
import { PdfDropzone } from "@/components/pdf-dropzone";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-foreground text-background flex size-7 items-center justify-center rounded-md font-mono text-xs font-bold">
            R
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Redline</span>
            <Badge variant="secondary" className="font-mono text-[10px] tracking-wide">
              Phase 1
            </Badge>
          </div>
        </div>
        <a
          href="/api/test-workflow"
          className="text-muted-foreground hover:text-foreground font-mono text-xs"
        >
          /api/test-workflow ↗
        </a>
      </header>

      <Separator className="my-8" />

      <main className="flex flex-1 flex-col gap-12">
        <section className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            Review a sprinkler plan
          </h1>
          <p className="text-muted-foreground max-w-xl text-sm">
            Upload a fire-sprinkler plan sheet. Redline extracts every note,
            verifies citations against the project&rsquo;s NFPA edition, and
            returns a marked-up PDF.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Project
          </label>
          <ProjectSwitcher />
        </section>

        <section className="flex flex-col gap-3">
          <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Plan PDF
          </label>
          <PdfDropzone />
        </section>
      </main>

      <footer className="text-muted-foreground mt-12 flex items-center justify-between font-mono text-[11px]">
        <span>Internal demo — NFPA 13 (chapters 8 &amp; 11)</span>
        <span>Hobby plan · Node runtime</span>
      </footer>
    </div>
  );
}
