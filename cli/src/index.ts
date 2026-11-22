import { runCli } from './runner';

process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  throw error;
});
runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : 'The command could not be completed.';
  // Line breaks stay, so each field a server refused prints on its own line.
  console.error(`Lobster: ${message.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')}`);
  process.exitCode = 1;
});
