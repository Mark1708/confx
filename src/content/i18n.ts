import { createTranslator } from "@/i18n";
import { loadSettings } from "@/lib/settings";

export async function loadContentTranslator(): Promise<ReturnType<typeof createTranslator>> {
  try {
    const settings = await loadSettings();
    return createTranslator(settings.locale);
  } catch (error) {
    console.warn("[cx] failed to load locale settings, using default locale fallback", error);
    return createTranslator();
  }
}
