/**
 * A very small DOM for tests: enough of an element to run the editor's
 * modules that read and write a page's markup (file-state.js, keep-inside.js)
 * on real markup, in node. Parsed with parse5, as the engine parses a page.
 *
 *   const h1 = page('<h1 data-cms="t"><span class="a">Hi</span></h1>');
 *   h1.innerHTML, h1.children, el.getAttribute('class'), el.cloneNode(true) …
 *
 * Not a browser: no layout, no styles, no events, and `matches` knows only
 * `.class`, `#id` and a comma between them.
 */
import { parseFragment } from 'parse5';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

class Node {
  constructor() { this.parentNode = null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
  get previousSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] || null : null; }
  remove() {
    const s = this.parentNode?.childNodes;
    if (s) s.splice(s.indexOf(this), 1);
    this.parentNode = null;
  }
}

class Text extends Node {
  constructor(data) { super(); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  cloneNode() { return new Text(this.data); }
}

class Element extends Node {
  constructor(tag) { super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = []; this.childNodes = []; }
  get attributes() { return this.attrs.map(a => ({ name: a.name, value: a.value })); }
  getAttribute(n) { return this.attrs.find(a => a.name === n)?.value ?? null; }
  hasAttribute(n) { return this.attrs.some(a => a.name === n); }
  setAttribute(n, v) { const a = this.attrs.find(x => x.name === n); if (a) a.value = String(v); else this.attrs.push({ name: n, value: String(v) }); }
  removeAttribute(n) { this.attrs = this.attrs.filter(a => a.name !== n); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  insertBefore(node, ref) {
    node.remove();
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at === -1) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  cloneNode(deep) {
    const c = new Element(this.tagName);
    c.attrs = this.attrs.map(a => ({ ...a }));
    if (deep) for (const n of this.childNodes) c.appendChild(n.cloneNode(true));
    return c;
  }
  matches(selector) {
    const cls = (this.getAttribute('class') || '').split(/\s+/);
    return selector.split(',').map(s => s.trim()).some(s => (s[0] === '.' ? cls.includes(s.slice(1)) : s[0] === '#' ? this.getAttribute('id') === s.slice(1) : this.tagName === s.toUpperCase()));
  }
  querySelectorAll(selector) { return all(this).filter(el => el.matches(selector)); }
  get innerHTML() { return this.childNodes.map(n => (n.nodeType === 1 ? n.outerHTML : esc(n.data))).join(''); }
  set innerHTML(html) {
    for (const n of [...this.childNodes]) n.remove();
    for (const n of fromParse5(parseFragment(String(html)).childNodes)) this.appendChild(n);
  }
  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    const open = `<${tag}${this.attrs.map(a => ` ${a.name}="${escAttr(a.value)}"`).join('')}>`;
    return VOID.has(tag) ? open : `${open}${this.innerHTML}</${tag}>`;
  }
}

function fromParse5(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.nodeName === '#text') out.push(new Text(n.value));
    else if (n.tagName) {
      const el = new Element(n.tagName);
      el.attrs = n.attrs.map(a => ({ name: a.name, value: a.value }));
      for (const c of fromParse5(n.childNodes || [])) el.appendChild(c);
      out.push(el);
    }
  }
  return out;
}

/** The one element `html` is. */
export function page(html) {
  return fromParse5(parseFragment(html).childNodes).find(n => n.nodeType === 1);
}

/** Every element inside `el`, in the order a page has them. */
export function all(el, out = []) {
  for (const c of el.children) { out.push(c); all(c, out); }
  return out;
}

/** What a browser's `el.style.x = v` does to the attribute, for the few declarations a test sets. */
export function setStyle(el, decls) {
  const have = new Map((el.getAttribute('style') || '').split(';').map(d => d.split(':').map(s => s.trim())).filter(d => d[0]));
  for (const [k, v] of Object.entries(decls)) { if (v === null) have.delete(k); else have.set(k, v); }
  if (have.size) el.setAttribute('style', [...have].map(([k, v]) => `${k}: ${v};`).join(' '));
  else el.removeAttribute('style');
}
