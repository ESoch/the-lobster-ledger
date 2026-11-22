import { createInterface } from 'node:readline/promises';
import type { WizardIO } from './create';
export function terminalWizard(print: (value: string) => void): WizardIO & { close(): void } {
  const line = createInterface({ input: process.stdin, output: process.stderr });
  return {
    print,
    close: () => line.close(),
    async ask(_key, label, options = {}) {
      for (;;) {
        if (options.choices)
          options.choices.forEach((choice, index) => print(`  ${index + 1}. ${choice.label}`));
        const raw = (
          await line.question(
            `${label}${options.defaultValue ? ` [${options.defaultValue}]` : ''}: `,
          )
        ).trim();
        const value = raw || options.defaultValue || '';
        if (options.choices) {
          const chosen =
            options.choices.find((choice) => choice.value.toLowerCase() === value.toLowerCase()) ??
            (/^\d+$/.test(value) ? options.choices[Number(value) - 1] : undefined);
          if (chosen) return chosen.value;
          print('Choose an option by its number or value.');
        } else if (value || options.optional) return value;
        else print('This field is required.');
      }
    },
  };
}
