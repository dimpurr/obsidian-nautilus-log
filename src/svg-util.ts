/*
 * svg-util.ts — minimal helpers for building SVG trees without any dependency.
 *
 * The vendored engine (`src/vendor/log-core.js`) owns all geometry; this module
 * only turns plain attribute maps and child nodes into SVG elements.  It is the
 * TypeScript counterpart of Reagent's `[:tag {attrs} ...children]` hiccup.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Attribute value that may be omitted entirely. */
export type SvgAttrValue = string | number | boolean | null | undefined;

/** A `style` map is merged into `element.style` rather than set as an attribute. */
export type SvgStyleMap = Record<string, string | number>;

export type SvgAttrs = Record<string, SvgAttrValue | SvgStyleMap>;

type AnyElement = Element & { style: CSSStyleDeclaration };

/**
 * Create an SVG element in the SVG namespace and populate it.
 *
 * - `null` / `undefined` / `false` attributes are skipped.
 * - A `style` object is merged into `element.style`.
 * - String children become text nodes; Node children are appended.
 */
export function createSvg(
  tag: string,
  attrs: SvgAttrs = {},
  ...children: Array<Node | string | null | undefined>
): Element {
  const el = document.createElementNS(SVG_NS, tag) as AnyElement;

  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "style") {
      setStyle(el, value as unknown as SvgStyleMap);
      continue;
    }
    el.setAttribute(name, String(value as SvgAttrValue));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  }

  return el;
}

/**
 * Merge a map of CSS declarations into an element's inline style.  Exists so
 * callers can set custom properties (`--pb-delay`) and px-lengths uniformly
 * without depending on a specific style API.
 */
export function setStyle(
  el: Element,
  styles: Record<string, string | number>,
): void {
  const style = (el as AnyElement).style;
  for (const [property, value] of Object.entries(styles)) {
    (style as unknown as Record<string, unknown>)[property] = String(value);
  }
}
