import type { FileNode } from './ipc'
import { normPath } from './pathIdentity'

export interface VisibleTreeEntry {
  node: FileNode
  parentPath: string | null
  level: number
  position: number
  siblings: number
  expanded: boolean
  children: FileNode[]
}

export function visibleTreeEntries(
  tree: FileNode[],
  expanded: Set<string>,
  children: Record<string, FileNode[]>
): VisibleTreeEntry[] {
  const entries: VisibleTreeEntry[] = []
  const expandedPaths = new Set([...expanded].map(normPath))
  const cachedChildren = new Map(Object.entries(children).map(([path, nodes]) => [normPath(path), nodes]))
  const visit = (nodes: FileNode[], parentPath: string | null, level: number): void => {
    nodes.forEach((node, index) => {
      const open = node.isDir && expandedPaths.has(normPath(node.path))
      const descendants = node.isDir ? cachedChildren.get(normPath(node.path)) ?? [] : []
      entries.push({ node, parentPath, level, position: index + 1, siblings: nodes.length, expanded: open, children: descendants })
      if (open) visit(descendants, node.path, level + 1)
    })
  }
  visit(tree, null, 1)
  return entries
}
