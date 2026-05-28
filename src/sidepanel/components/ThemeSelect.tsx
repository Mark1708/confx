import { Palette } from "lucide-react";
import { THEME_LABELS, THEMES } from "@/lib/settings";
import type { Theme } from "@/types";
import { useSettings } from "../hooks/useSettings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export function ThemeSelect() {
  const { data, update } = useSettings();
  const theme: Theme = data?.theme ?? "dark";
  return (
    <Select value={theme} onValueChange={(v) => update({ theme: v as Theme })}>
      <SelectTrigger className="h-7 w-auto max-w-[5.5rem] shrink-0 gap-1 px-1.5 py-1 text-[10px] wide-panel:max-w-[7rem] wide-panel:px-2 wide-panel:text-[11px]" aria-label="Тема">
        <Palette className="h-3 w-3 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {THEMES.map((t) => (
          <SelectItem key={t} value={t}>
            {THEME_LABELS[t]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
