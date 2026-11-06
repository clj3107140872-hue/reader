import { load } from 'cheerio'

const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'blockquote', 'pre', 'tr', 'table'
].join(',')

/** Converts an HTML fragment to trimmed, non-empty paragraphs. */
export function htmlToParagraphs(html: string): string[] {
  const $ = load(`<div id="__root__">${html}</div>`)
  const root = $('#__root__')
  root.find('script,style,iframe,noscript,svg,canvas').remove()
  root.find('br').replaceWith('\n')
  root.find(BLOCK_TAGS).each((_index, node) => {
    $(node).append('\n')
  })
  return root
    .text()
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
}

export function htmlToText(html: string): string {
  return htmlToParagraphs(html).join('\n\n')
}
