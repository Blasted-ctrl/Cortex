import type { FileNode } from './ipc'

export interface VisibleTreeEntry {
  node: FileNode
  parentPath: string | null
  level: number
  position: number
  siblings: number
}

export function visibleTreeEntries(
  tree: FileNode[],
  expanded: Set<string>,
  children: Record<string, FileNode[]>
): VisibleTreeEntry[] {
  const entries: VisibleTreeEntry[] = []
  const visit = (nodes: FileNode[], parentPath: string | null, level: number): void => {
    nodes.forEach((node, index) => {
      entries.push({ node, parentPath, level, position: index + 1, siblings: nodes.length })
      if (node.isDir && expanded.has(node.path)) visit(children[node.path] ?? [], node.path, level + 1)
    })
  }
  visit(tree, null, 1)
  return entries
}
