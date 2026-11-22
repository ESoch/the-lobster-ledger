import { Fragment } from 'react';

// Only https links become links. Closing punctuation after a URL belongs to the sentence.
const HTTPS_URL = /https:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]}'"”’]+$/;

/** Shows member-entered text as written, with its https links clickable. */
export function LinkifiedText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(HTTPS_URL)) {
    const start = match.index;
    const url = match[0].replace(TRAILING, '');
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a key={start} href={url} target="_blank" rel="noreferrer noopener">
        {url}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
