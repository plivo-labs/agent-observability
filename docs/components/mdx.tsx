import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import {
  ComponentPreview,
  LatencyChartPreview,
  SessionsPagePreview,
} from '@/components/previews';
import { InstallTabs, ParamsTable, PropsTable } from '@/components/mdx-blocks';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Live-preview resolver — <ComponentPreview slug="…" /> mounts the matching
    // ssr:false client island. Importing it here forces every wired island
    // (and the registry component it pulls in) into the build graph.
    ComponentPreview,
    // Reusable doc blocks.
    InstallTabs,
    PropsTable,
    ParamsTable,
    // Legacy named previews kept for the existing chart.mdx / sessions.mdx.
    LatencyChartPreview,
    SessionsPagePreview,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
