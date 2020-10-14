/**
 * @author Kuitos
 * @since 2019-10-21
 */
import { execScripts } from 'import-html-entry';
import { isFunction } from 'lodash';
import { frameworkConfiguration } from '../../../apis';

import * as css from '../css';

export const rawHeadAppendChild = HTMLHeadElement.prototype.appendChild;
const rawHeadRemoveChild = HTMLHeadElement.prototype.removeChild;
const rawBodyAppendChild = HTMLBodyElement.prototype.appendChild;
const rawBodyRemoveChild = HTMLBodyElement.prototype.removeChild;
const rawHeadInsertBefore = HTMLHeadElement.prototype.insertBefore;
const rawRemoveChild = HTMLElement.prototype.removeChild;

const SCRIPT_TAG_NAME = 'SCRIPT';
const LINK_TAG_NAME = 'LINK';
const STYLE_TAG_NAME = 'STYLE';

export function isHijackingTag(tagName?: string) {
  return (
    tagName?.toUpperCase() === LINK_TAG_NAME ||
    tagName?.toUpperCase() === STYLE_TAG_NAME ||
    tagName?.toUpperCase() === SCRIPT_TAG_NAME
  );
}

/**
 * Check if a style element is a styled-component liked.
 * A styled-components liked element is which not have textContext but keep the rules in its styleSheet.cssRules.
 * Such as the style element generated by styled-components and emotion.
 * @param element
 */
export function isStyledComponentsLike(element: HTMLStyleElement) {
  return (
    !element.textContent &&
    ((element.sheet as CSSStyleSheet)?.cssRules.length || getStyledElementCSSRules(element)?.length)
  );
}

const styledComponentCSSRulesMap = new WeakMap<HTMLStyleElement, CSSRuleList>();
const dynamicScriptAttachedCommentMap = new WeakMap<HTMLScriptElement, Comment>();

export function recordStyledComponentsCSSRules(styleElements: HTMLStyleElement[]): void {
  styleElements.forEach(styleElement => {
    /*
     With a styled-components generated style element, we need to record its cssRules for restore next re-mounting time.
     We're doing this because the sheet of style element is going to be cleaned automatically by browser after the style element dom removed from document.
     see https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
     */
    if (styleElement instanceof HTMLStyleElement && isStyledComponentsLike(styleElement)) {
      if (styleElement.sheet) {
        // record the original css rules of the style element for restore
        styledComponentCSSRulesMap.set(styleElement, (styleElement.sheet as CSSStyleSheet).cssRules);
      }
    }
  });
}

export function getStyledElementCSSRules(styledElement: HTMLStyleElement): CSSRuleList | undefined {
  return styledComponentCSSRulesMap.get(styledElement);
}

function patchCustomEvent(e: CustomEvent, elementGetter: () => HTMLScriptElement | null): CustomEvent {
  Object.defineProperties(e, {
    srcElement: {
      get: elementGetter,
    },
    target: {
      get: elementGetter,
    },
  });
  return e;
}

export type ContainerConfig = {
  appName: string;
  proxy: WindowProxy;
  strictGlobal: boolean;
  dynamicStyleSheetElements: HTMLStyleElement[];
  appWrapperGetter: CallableFunction;
  scopedCSS: boolean;
  excludeAssetFilter?: CallableFunction;
};

function getOverwrittenAppendChildOrInsertBefore(opts: {
  rawDOMAppendOrInsertBefore: <T extends Node>(newChild: T, refChild?: Node | null) => T;
  isInvokedByMicroApp: (element: HTMLElement) => boolean;
  containerConfigGetter: (element: HTMLElement) => ContainerConfig;
}) {
  return function appendChildOrInsertBefore<T extends Node>(
    this: HTMLHeadElement | HTMLBodyElement,
    newChild: T,
    refChild?: Node | null,
  ) {
    let element = newChild as any;
    const { rawDOMAppendOrInsertBefore, isInvokedByMicroApp, containerConfigGetter } = opts;
    if (!isInvokedByMicroApp(element)) {
      return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
    }

    if (element.tagName) {
      const containerConfig = containerConfigGetter(element);
      const {
        appName,
        appWrapperGetter,
        proxy,
        strictGlobal,
        dynamicStyleSheetElements,
        scopedCSS,
        excludeAssetFilter,
      } = containerConfig;

      switch (element.tagName) {
        case LINK_TAG_NAME:
        case STYLE_TAG_NAME: {
          const stylesheetElement: HTMLLinkElement | HTMLStyleElement = newChild as any;
          const { href } = stylesheetElement as HTMLLinkElement;
          if (excludeAssetFilter && href && excludeAssetFilter(href)) {
            return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
          }

          const mountDOM = appWrapperGetter();

          if (scopedCSS) {
            css.process(mountDOM, stylesheetElement, appName);
          }

          // eslint-disable-next-line no-shadow
          dynamicStyleSheetElements.push(stylesheetElement);
          const referenceNode = mountDOM.contains(refChild) ? refChild : null;
          return rawDOMAppendOrInsertBefore.call(mountDOM, stylesheetElement, referenceNode);
        }

        case SCRIPT_TAG_NAME: {
          const { src, text } = element as HTMLScriptElement;
          // some script like jsonp maybe not support cors which should't use execScripts
          if (excludeAssetFilter && src && excludeAssetFilter(src)) {
            return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
          }

          const mountDOM = appWrapperGetter();
          const { fetch } = frameworkConfiguration;
          const referenceNode = mountDOM.contains(refChild) ? refChild : null;

          if (src) {
            execScripts(null, [src], proxy, {
              fetch,
              strictGlobal,
              beforeExec: () => {
                Object.defineProperty(document, 'currentScript', {
                  get(): any {
                    return element;
                  },
                  configurable: true,
                });
              },
              success: () => {
                // we need to invoke the onload event manually to notify the event listener that the script was completed
                // here are the two typical ways of dynamic script loading
                // 1. element.onload callback way, which webpack and loadjs used, see https://github.com/muicss/loadjs/blob/master/src/loadjs.js#L138
                // 2. addEventListener way, which toast-loader used, see https://github.com/pyrsmk/toast/blob/master/src/Toast.ts#L64
                const loadEvent = new CustomEvent('load');
                if (isFunction(element.onload)) {
                  element.onload(patchCustomEvent(loadEvent, () => element));
                } else {
                  element.dispatchEvent(loadEvent);
                }

                element = null;
              },
              error: () => {
                const errorEvent = new CustomEvent('error');
                if (isFunction(element.onerror)) {
                  element.onerror(patchCustomEvent(errorEvent, () => element));
                } else {
                  element.dispatchEvent(errorEvent);
                }

                element = null;
              },
            });

            const dynamicScriptCommentElement = document.createComment(`dynamic script ${src} replaced by qiankun`);
            dynamicScriptAttachedCommentMap.set(element, dynamicScriptCommentElement);
            return rawDOMAppendOrInsertBefore.call(mountDOM, dynamicScriptCommentElement, referenceNode);
          }

          execScripts(null, [`<script>${text}</script>`], proxy, {
            strictGlobal,
            success: element.onload,
            error: element.onerror,
          });
          const dynamicInlineScriptCommentElement = document.createComment('dynamic inline script replaced by qiankun');
          dynamicScriptAttachedCommentMap.set(element, dynamicInlineScriptCommentElement);
          return rawDOMAppendOrInsertBefore.call(mountDOM, dynamicInlineScriptCommentElement, referenceNode);
        }

        default:
          break;
      }
    }

    return rawDOMAppendOrInsertBefore.call(this, element, refChild);
  };
}

function getNewRemoveChild(
  headOrBodyRemoveChild: typeof HTMLElement.prototype.removeChild,
  appWrapperGetterGetter: (element: HTMLElement) => ContainerConfig['appWrapperGetter'],
) {
  return function removeChild<T extends Node>(this: HTMLHeadElement | HTMLBodyElement, child: T) {
    try {
      const { tagName } = child as any;
      if (isHijackingTag(tagName)) {
        const appWrapperGetter = appWrapperGetterGetter(child as any);

        // container may had been removed while app unmounting if the removeChild action was async
        const container = appWrapperGetter();
        const attachedElement = dynamicScriptAttachedCommentMap.get(child as any) || child;
        if (container.contains(attachedElement)) {
          return rawRemoveChild.call(container, attachedElement) as T;
        }
      }
    } catch (e) {
      console.warn(e);
    }

    return headOrBodyRemoveChild.call(this, child) as T;
  };
}

export function patchHTMLDynamicAppendPrototypeFunctions(
  isInvokedByMicroApp: (element: HTMLElement) => boolean,
  containerConfigGetter: (element: HTMLElement) => ContainerConfig,
) {
  // Just overwrite it while it have not been overwrite
  if (
    HTMLHeadElement.prototype.appendChild === rawHeadAppendChild &&
    HTMLBodyElement.prototype.appendChild === rawBodyAppendChild &&
    HTMLHeadElement.prototype.insertBefore === rawHeadInsertBefore
  ) {
    HTMLHeadElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadAppendChild,
      containerConfigGetter,
      isInvokedByMicroApp,
    }) as typeof rawHeadAppendChild;
    HTMLBodyElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawBodyAppendChild,
      containerConfigGetter,
      isInvokedByMicroApp,
    }) as typeof rawBodyAppendChild;

    HTMLHeadElement.prototype.insertBefore = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadInsertBefore as any,
      containerConfigGetter,
      isInvokedByMicroApp,
    }) as typeof rawHeadInsertBefore;
  }

  // Just overwrite it while it have not been overwrite
  if (
    HTMLHeadElement.prototype.removeChild === rawHeadRemoveChild &&
    HTMLBodyElement.prototype.removeChild === rawBodyRemoveChild
  ) {
    HTMLHeadElement.prototype.removeChild = getNewRemoveChild(
      rawHeadRemoveChild,
      element => containerConfigGetter(element).appWrapperGetter,
    );
    HTMLBodyElement.prototype.removeChild = getNewRemoveChild(
      rawBodyRemoveChild,
      element => containerConfigGetter(element).appWrapperGetter,
    );
  }

  return function unpatch() {
    HTMLHeadElement.prototype.appendChild = rawHeadAppendChild;
    HTMLHeadElement.prototype.removeChild = rawHeadRemoveChild;
    HTMLBodyElement.prototype.appendChild = rawBodyAppendChild;
    HTMLBodyElement.prototype.removeChild = rawBodyRemoveChild;

    HTMLHeadElement.prototype.insertBefore = rawHeadInsertBefore;
  };
}

export function rebuildCSSRules(
  styleSheetElements: HTMLStyleElement[],
  reAppendElement: (stylesheetElement: HTMLStyleElement) => void,
) {
  styleSheetElements.forEach(stylesheetElement => {
    // re-append the dynamic stylesheet to sub-app container
    // Using document.head.appendChild ensures that appendChild invocation can also directly use the HTMLHeadElement.prototype.appendChild method which is overwritten at mounting phase
    reAppendElement(stylesheetElement);

    /*
    get the stored css rules from styled-components generated element, and the re-insert rules for them.
    note that we must do this after style element had been added to document, which stylesheet would be associated to the document automatically.
    check the spec https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
     */
    if (stylesheetElement instanceof HTMLStyleElement && isStyledComponentsLike(stylesheetElement)) {
      const cssRules = getStyledElementCSSRules(stylesheetElement);
      if (cssRules) {
        // eslint-disable-next-line no-plusplus
        for (let i = 0; i < cssRules.length; i++) {
          const cssRule = cssRules[i];
          (stylesheetElement.sheet as CSSStyleSheet).insertRule(cssRule.cssText);
        }
      }
    }
  });
}
