export const SUPPORTED_LOCALES = ["ru", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocaleOverride = "auto" | Locale;

export const DEFAULT_LOCALE: Locale = "en";
export const DEFAULT_LOCALE_OVERRIDE: LocaleOverride = "auto";

export type DictionaryLeaf = string;
export type DictionaryTree = {
  readonly [key: string]: DictionaryLeaf | DictionaryTree;
};

export type DictionaryShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends DictionaryTree
      ? DictionaryShape<T[Key]>
      : never;
};

type JoinPath<Prefix extends string, Key extends string> = Prefix extends ""
  ? Key
  : `${Prefix}.${Key}`;

export type DictionaryKey<T, Prefix extends string = ""> = {
  [Key in keyof T & string]: T[Key] extends string
    ? JoinPath<Prefix, Key>
    : T[Key] extends DictionaryTree
      ? DictionaryKey<T[Key], JoinPath<Prefix, Key>>
      : never;
}[keyof T & string];

export type InterpolationValues = Readonly<Record<string, string | number | boolean>>;

export interface TranslateOptions {
  readonly values?: InterpolationValues;
  readonly fallback?: string;
}

export type Translator<Key extends string> = (key: Key, values?: InterpolationValues) => string;
