import { PRESETS } from "@/lib/rule-engine";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface Props {
  value: string;
  onChange: (id: string) => void;
}

export function PresetSelector({ value, onChange }: Props) {
  const active = PRESETS.find((p) => p.id === value) ?? PRESETS[0];
  return (
    <div className="space-y-1">
      <Label>Набор правил</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-tight text-muted-foreground">{active.description}</p>
    </div>
  );
}
