/** Locale-aware number formatting (config.numberLocale, e.g. "de-DE" for German). */
export function makeFormatter(locale: string) {
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const percent = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  return {
    int: (n: number) => integer.format(Math.round(n)),
    num: (n: number) => decimal.format(n),
    pct: (n: number) => percent.format(n),
  };
}

export type Formatter = ReturnType<typeof makeFormatter>;
