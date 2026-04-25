"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Phase 1 — projects are hardcoded. Real list comes from the `projects`
// table (db/schema.sql) in Phase 2 once seeding lands.
const DEMO_PROJECTS = [
  { id: "demo-oc", name: "OC Office Building", edition: "NFPA 13 2022" },
  { id: "demo-houston", name: "Houston Warehouse", edition: "NFPA 13 2019" },
] as const;

export function ProjectSwitcher() {
  const [value, setValue] = React.useState<string>(DEMO_PROJECTS[0].id);
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger className="h-9 w-[280px]">
        <SelectValue placeholder="Choose a project" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Projects</SelectLabel>
          {DEMO_PROJECTS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <span className="flex flex-col">
                <span className="text-sm">{p.name}</span>
                <span className="text-muted-foreground text-xs">{p.edition}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
