import { Palette } from "lucide-react";
import { THEMES } from "@/lib/settings";
import type { Theme } from "@/types";
import { useI18n } from "../hooks/useI18n";
import { useSettings } from "../hooks/useSettings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export function ThemeSelect() {
  const { data, update } = useSettings();
  const { t } = useI18n();
  const theme: Theme = data?.theme ?? "dark";
  return (
    <Select value={theme} onValueChange={(v) => update({ theme: v as Theme })}>
      <SelectTrigger
        className="h-7 w-auto max-w-[5.5rem] shrink-0 gap-1 px-1.5 py-1 text-[10px] wide-panel:max-w-[7rem] wide-panel:px-2 wide-panel:text-[11px]"
        aria-label={t("settings.theme.label")}
      >
        <Palette className="h-3 w-3 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {THEMES.map((themeOption) => (
          <SelectItem key={themeOption} value={themeOption}>
            {themeOption === "dark" ? t("settings.theme.dark") : t("settings.theme.light")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
