import { act, type ReactElement } from 'react'
import Reconciler from 'react-reconciler'

export type HostNode = {
  type: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | Container | null
  focus: () => void
  select: () => void
  getBoundingClientRect: () => { left: number; top: number; bottom: number; width: number; height: number }
  querySelector: (selector: string) => HostNode | null
}
type Container = { children: HostNode[] }
export const descendants = (parent: Container): HostNode[] => parent.children.flatMap((node) => [node, ...descendants(node)])
export function invoke(node: HostNode, handler: string, event: object): void {
  const callback = node.props[handler]
  if (typeof callback !== 'function') throw new Error(`Handler missing: ${handler}`)
  callback(event)
}

export function createHost(): {
  nodes: () => HostNode[]
  focused: () => HostNode | null
  render: (element: ReactElement | null) => Promise<void>
} {
  const container: Container = { children: [] }
  let focused: HostNode | null = null
  const append = (parent: HostNode | Container, child: HostNode): void => {
    const old = parent.children.indexOf(child)
    if (old !== -1) parent.children.splice(old, 1)
    parent.children.push(child)
    child.parent = parent
  }
  const remove = (parent: HostNode | Container, child: HostNode): void => {
    parent.children.splice(parent.children.indexOf(child), 1)
    child.parent = null
  }
  const insert = (parent: HostNode | Container, child: HostNode, before: HostNode): void => {
    const old = parent.children.indexOf(child)
    if (old !== -1) parent.children.splice(old, 1)
    parent.children.splice(parent.children.indexOf(before), 0, child)
    child.parent = parent
  }
  const createNode = (type: string, props: Record<string, unknown>): HostNode => {
    const node: HostNode = {
      type, props, children: [], parent: null,
      select: () => undefined,
      getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 34, width: 200, height: 24 }),
      querySelector: (selector) => descendants(node).find((child) => child.type === selector) ?? null,
      focus: () => {
        focused = node
        const ancestors: HostNode[] = []
        let parent = node.parent
        while (parent && 'props' in parent) {
          ancestors.unshift(parent)
          parent = parent.parent
        }
        for (const ancestor of ancestors) {
          if (typeof ancestor.props.onFocusCapture === 'function') ancestor.props.onFocusCapture({ target: node, currentTarget: ancestor })
        }
        if (typeof node.props.onFocus === 'function') node.props.onFocus({ target: node, currentTarget: node })
      }
    }
    return node
  }
  // Real React hooks and refs; the host models only focus/layout, not a browser
  // accessibility tree. Native keyboard/visibility checks remain a separate gate.
  const renderer = Reconciler({
    supportsMutation: true, supportsPersistence: false, supportsHydration: false,
    isPrimaryRenderer: false, now: Date.now, noTimeout: -1,
    scheduleTimeout: setTimeout, cancelTimeout: clearTimeout,
    getRootHostContext: () => null, getChildHostContext: () => null,
    getPublicInstance: (node: HostNode) => node,
    createInstance: createNode,
    createTextInstance: (text: string) => createNode('#text', { text }),
    appendInitialChild: append, appendChild: append, appendChildToContainer: append,
    removeChild: remove, removeChildFromContainer: remove,
    insertBefore: insert, insertInContainerBefore: insert,
    prepareUpdate: () => true,
    commitUpdate: (node: HostNode, _update: boolean, _type: string, _old: unknown, props: Record<string, unknown>) => { node.props = props },
    commitTextUpdate: (node: HostNode, _old: string, text: string) => { node.props = { text } },
    shouldSetTextContent: () => false, finalizeInitialChildren: () => false,
    prepareForCommit: () => null, resetAfterCommit: () => undefined,
    preparePortalMount: () => undefined, detachDeletedInstance: () => undefined,
    clearContainer: (target: Container) => { target.children = [] },
    getCurrentEventPriority: () => 16
  })
  const root = renderer.createContainer(container, 0, null, false, null, '', (error) => { throw error }, null)
  return {
    nodes: () => descendants(container), focused: () => focused,
    render: async (element) => { await act(async () => { renderer.updateContainer(element, root) }) }
  }
}
