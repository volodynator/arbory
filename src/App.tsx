import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { BadgeCheck, Check, ChevronDown, Circle, CircleCheckBig, Clock, Copy, Eraser, File, FileArchive, FileCode2, FileImage, FileText, Film, Link2, Paperclip, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { check } from "@tauri-apps/plugin-updater";

type TreeNode = {
  id: string;
  title: string;
  done: boolean;
  content: string;
  url?: string;
  files: { name: string; size: number; data: string }[];
  children: TreeNode[];
};

type Project = {
  id: string;
  name: string;
  tree: TreeNode;
  trash: TrashEntry[];
  deleted?: boolean;
};

type TrashEntry = {
  node: TreeNode;
  parentId: string | null;
  index: number;
};

type WorkspacePayload = {
  projects: Project[];
  activeProjectId: string;
  selectedNodeId: string;
};

type StorageStatus = "loading" | "saving" | "saved" | "error";

type PersistedTreeNode = {
  id: string;
  title: string;
  done: boolean;
  noteFile: string;
  url?: string;
  filesDir?: string;
  files: { name: string; size: number; data: string }[];
  children: PersistedTreeNode[];
};

type PersistedProject = {
  id: string;
  name: string;
  tree: PersistedTreeNode;
  trash: PersistedTrashEntry[];
  deleted: boolean;
};

type PersistedTrashEntry = {
  node: PersistedTreeNode;
  parentId: string | null;
  index: number;
};

type PersistedWorkspace = {
  projects: PersistedProject[];
  activeProjectId: string;
  selectedNodeId: string;
};

type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installed" | "error";

const APP_STORAGE_DIR = "notion-forest";
const PROJECTS_FILE = "projects.json";

const supportsOpfs = () => {
  return typeof navigator !== "undefined" && "storage" in navigator && typeof navigator.storage.getDirectory === "function";
};

const safeNoteFilename = (nodeId: string) => {
  const cleaned = nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${cleaned || "note"}.html`;
};

const writeTextFile = async (fileHandle: FileSystemFileHandle, content: string) => {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

const readTextFile = async (dir: FileSystemDirectoryHandle, filePath: string) => {
  const segments = filePath.split("/").filter(Boolean);
  let cursor: FileSystemDirectoryHandle = dir;

  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = await cursor.getDirectoryHandle(segments[i]);
  }

  const fileHandle = await cursor.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  return file.text();
};

const getStorageFolders = async () => {
  if (!supportsOpfs()) {
    throw new Error("Browser storage API is not available in this runtime");
  }

  const storage = navigator.storage as StorageManager & {
    getDirectory: () => Promise<FileSystemDirectoryHandle>;
  };
  const root = await storage.getDirectory();
  const appDir = await root.getDirectoryHandle(APP_STORAGE_DIR, { create: true });
  const notesDir = await appDir.getDirectoryHandle("notes", { create: true });

  return { appDir, notesDir };
};

const persistNode = async (
  node: TreeNode,
  notesDir: FileSystemDirectoryHandle
): Promise<PersistedTreeNode> => {
  const fileName = safeNoteFilename(node.id);
  const fileHandle = await notesDir.getFileHandle(fileName, { create: true });
  await writeTextFile(fileHandle, node.content);

  const children: PersistedTreeNode[] = [];
  for (const child of node.children) {
    children.push(await persistNode(child, notesDir));
  }

  return {
    id: node.id,
    title: node.title,
    done: node.done,
    noteFile: `notes/${fileName}`,
    url: node.url,
    files: node.files,
    children
  };
};

const hydrateNode = async (
  node: PersistedTreeNode,
  appDir: FileSystemDirectoryHandle
): Promise<TreeNode> => {
  let content = "<p></p>";
  try {
    content = await readTextFile(appDir, node.noteFile);
  } catch {
    content = "<p></p>";
  }

  const children: TreeNode[] = [];
  for (const child of node.children) {
    children.push(await hydrateNode(child, appDir));
  }

  return {
    id: node.id,
    title: node.title,
    done: node.done,
    content,
    url: node.url,
    files: node.files ?? [],
    children
  };
};

const saveWorkspaceToFiles = async (payload: WorkspacePayload) => {
  const { appDir, notesDir } = await getStorageFolders();

  const persistedProjects: PersistedProject[] = [];
  for (const project of payload.projects) {
    const trashPersistedNodes: PersistedTrashEntry[] = [];
    for (const trashNode of project.trash) {
      trashPersistedNodes.push({
        node: await persistNode(trashNode.node, notesDir),
        parentId: trashNode.parentId,
        index: trashNode.index
      });
    }

    persistedProjects.push({
      id: project.id,
      name: project.name,
      tree: await persistNode(project.tree, notesDir),
      trash: trashPersistedNodes,
      deleted: project.deleted === true
    });
  }

  const persisted: PersistedWorkspace = {
    projects: persistedProjects,
    activeProjectId: payload.activeProjectId,
    selectedNodeId: payload.selectedNodeId
  };

  const projectsHandle = await appDir.getFileHandle(PROJECTS_FILE, { create: true });
  await writeTextFile(projectsHandle, JSON.stringify(persisted, null, 2));
};

const loadWorkspaceFromFiles = async (): Promise<WorkspacePayload | null> => {
  const { appDir } = await getStorageFolders();

  let persisted: PersistedWorkspace;
  try {
    const projectsHandle = await appDir.getFileHandle(PROJECTS_FILE);
    const json = await (await projectsHandle.getFile()).text();
    persisted = JSON.parse(json) as PersistedWorkspace;
  } catch {
    return null;
  }

  const projects: Project[] = [];
  for (const project of persisted.projects) {
    const trashNodes: TrashEntry[] = [];
    if (project.trash && Array.isArray(project.trash)) {
      for (const trashNode of project.trash) {
        if (trashNode && typeof trashNode === "object" && "node" in trashNode) {
          const entry = trashNode as PersistedTrashEntry;
          trashNodes.push({
            node: await hydrateNode(entry.node, appDir),
            parentId: entry.parentId ?? null,
            index: Number.isFinite(entry.index) ? entry.index : 0
          });
        } else {
          trashNodes.push({
            node: await hydrateNode(trashNode as PersistedTreeNode, appDir),
            parentId: null,
            index: 0
          });
        }
      }
    }

    projects.push({
      id: project.id,
      name: project.name,
      tree: await hydrateNode(project.tree, appDir),
      trash: trashNodes,
      deleted: project.deleted ?? false
    });
  }

  return {
    projects,
    activeProjectId: persisted.activeProjectId,
    selectedNodeId: persisted.selectedNodeId
  };
};

const createNode = (title: string): TreeNode => ({
  id: crypto.randomUUID(),
  title,
  done: false,
  content: `<h1>${title}</h1><p>Start writing notes, decisions and task details here.</p>`,
  url: undefined,
  files: [],
  children: []
});

const escapeHtml = (str: string) =>
  str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const setTitleInContent = (content: string, title: string) => {
  try {
    // Replace first heading (h1..h6) if present, otherwise prepend h1
    const escaped = escapeHtml(title);
    const headingRegex = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i;
    if (headingRegex.test(content)) {
      return content.replace(headingRegex, `<h1>${escaped}</h1>`);
    }

    return `<h1>${escaped}</h1>` + content;
  } catch (e) {
    return `<h1>${escapeHtml(title)}</h1>` + content;
  }
};

const isNodeComplete = (node: TreeNode): boolean => {
  if (node.children.length === 0) return node.done;
  return node.children.every(isNodeComplete);
};

const subtreeCompletion = (node: TreeNode): { done: number; total: number } => {
  const selfDone = isNodeComplete(node) ? 1 : 0;
  const fromChildren = node.children.reduce(
    (acc, child) => {
      const childResult = subtreeCompletion(child);
      return {
        done: acc.done + childResult.done,
        total: acc.total + childResult.total
      };
    },
    { done: 0, total: 0 }
  );

  return {
    done: selfDone + fromChildren.done,
    total: 1 + fromChildren.total
  };
};

const getProjectCompletionPercent = (project: Project) => {
  const stats = subtreeCompletion(project.tree);
  return Math.round((stats.done / stats.total) * 100);
};

const updateNodeById = (
  node: TreeNode,
  targetId: string,
  updateFn: (node: TreeNode) => TreeNode
): TreeNode => {
  if (node.id === targetId) return updateFn(node);

  return {
    ...node,
    children: node.children.map((child) => updateNodeById(child, targetId, updateFn))
  };
};

const findNodeById = (node: TreeNode, targetId: string): TreeNode | null => {
  if (node.id === targetId) return node;

  for (const child of node.children) {
    const found = findNodeById(child, targetId);
    if (found) return found;
  }

  return null;
};

const findNodeLocationById = (
  node: TreeNode,
  targetId: string,
  parentId: string | null = null
): { node: TreeNode; parentId: string | null; index: number } | null => {
  if (node.id === targetId) {
    return { node, parentId, index: 0 };
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.id === targetId) {
      return { node: child, parentId: node.id, index };
    }

    const found = findNodeLocationById(child, targetId, node.id);
    if (found) {
      return found;
    }
  }

  return null;
};

const stripNodeChildren = (node: TreeNode): TreeNode => ({
  ...node,
  children: []
});

const insertNodeIntoTree = (
  node: TreeNode,
  parentId: string,
  childNode: TreeNode,
  index: number
): { tree: TreeNode; inserted: boolean } => {
  if (node.id === parentId) {
    const nextChildren = [...node.children];
    const safeIndex = Math.min(Math.max(index, 0), nextChildren.length);
    nextChildren.splice(safeIndex, 0, childNode);
    return {
      tree: {
        ...node,
        children: nextChildren
      },
      inserted: true
    };
  }

  let inserted = false;
  const children = node.children.map((child) => {
    const result = insertNodeIntoTree(child, parentId, childNode, index);
    if (result.inserted) {
      inserted = true;
    }
    return result.tree;
  });

  return {
    tree: inserted ? { ...node, children } : node,
    inserted
  };
};

const htmlToPlainText = (html: string) => {
  if (typeof DOMParser === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent?.replace(/\s+/g, " ").trim() || "";
};

const removeFirstHeadingFromHtml = (html: string) => {
  try {
    // remove the first <h1..h6>...</h1> occurrence
    return html.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i, "");
  } catch (e) {
    return html;
  }
};

const buildPromptFromNode = (node: TreeNode) => {
  const shortHeader = [
    "You are my high-level strategic AI assistant and execution partner.",
    "Analyze tasks deeply, identify risks and blockers, and produce clear, actionable plans.",
    "For each task provide: Objective, Analysis, Risks/Blockers, Missing info, Recommended approach, Step-by-step plan, Priority, Difficulty, Tools, Final recommendations.",
    "Compare alternatives, explain tradeoffs, and recommend concrete next steps.",
    "Be concise, structured, and ask only essential clarifying questions when needed.",
    "",
    "---",
    ""
  ];

  try {
    const lines: string[] = [
      ...shortHeader,
    "Task:",
    node.title,
    `Status: ${node.done ? "done" : "in progress"}`
  ];

  if (node.url) {
    lines.push(`Link: ${node.url}`);
  }

  const contentForDescription = removeFirstHeadingFromHtml(node.content);
  const noteText = htmlToPlainText(contentForDescription);
  if (noteText) {
    lines.push("", "Description:", noteText);
  }

  if (node.files.length > 0) {
    lines.push("", "Attachments:");
    for (const file of node.files) {
      lines.push(`- ${file.name}`);
    }
  }

  const writeChildren = (children: TreeNode[], depth: number) => {
    for (const child of children) {
      const prefix = "  ".repeat(depth);
      lines.push("", `${prefix}- ${child.title} (${child.done ? "done" : "in progress"})`);

      const childNotes = htmlToPlainText(child.content);
      if (childNotes) {
        lines.push(`${prefix}  Description: ${childNotes}`);
      }

      if (child.url) {
        lines.push(`${prefix}  Link: ${child.url}`);
      }

      if (child.files.length > 0) {
        lines.push(`${prefix}  Attachments:`);
        for (const file of child.files) {
          lines.push(`${prefix}  - ${file.name}`);
        }
      }

      if (child.children.length > 0) {
        lines.push(`${prefix}  Subtasks:`);
        writeChildren(child.children, depth + 2);
      }
    }
  };

  if (node.children.length > 0) {
    lines.push("", "Subtasks:");
    writeChildren(node.children, 1);
  }

    // keep the prompt focused on the instruction block + task details

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch (err) {
    console.error("buildPromptFromNode failed", err);
    return `Error generating prompt: ${err instanceof Error ? err.message : String(err)}`;
  }
};

const initialProjects: Project[] = [
  {
    id: crypto.randomUUID(),
    name: "Getting Started",
    tree: {
      id: crypto.randomUUID(),
      title: "Welcome to Arbory",
      done: false,
      content: "<h2>How to use this workspace</h2><p>1. Click <strong>New project</strong> to create a project.</p><p>2. Select any node to edit its title, content, link, and files.</p><p>3. Use <strong>Add child</strong> to break work into smaller steps.</p><p>4. Drag the panel edge to resize the left sidebar.</p><p>5. Mark tasks complete when you finish them.</p>",
      url: undefined,
      files: [],
      children: [
        {
          id: crypto.randomUUID(),
          title: "Create your first node",
          done: true,
          content: "<p>Select the root node and start editing node content.</p>",
          url: undefined,
          files: [],
          children: []
        },
        {
          id: crypto.randomUUID(),
          title: "Add sub-tasks",
          done: false,
          content: "<p>Use <strong>Add child</strong> to create subtasks for any node.</p>",
          url: undefined,
          files: [],
          children: []
        },
        {
          id: crypto.randomUUID(),
          title: "Resize the sidebar",
          done: false,
          content: "<p>Drag the left panel edge to make the project list wider or narrower.</p>",
          url: undefined,
          files: [],
          children: []
        }
      ]
    },
    trash: []
  }
];

type TreeCardProps = {
  node: TreeNode;
  selectedId: string;
  depth: number;
  onSelect: (nodeId: string) => void;
  collapsedNodes: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
};

function TreeCard({ node, selectedId, depth, onSelect, collapsedNodes, onToggleCollapse }: TreeCardProps) {
  const done = isNodeComplete(node);
  const completion = subtreeCompletion(node);
  const percent = Math.round((completion.done / completion.total) * 100);
  const isCollapsed = collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;

  const handleTitleClick = (e: React.MouseEvent) => {
    if (node.url) {
      e.preventDefault();
      window.open(node.url, "_blank");
    } else {
      onSelect(node.id);
    }
  };

  return (
    <li className="tree-item">
      <div className={`tree-card ${selectedId === node.id ? "is-selected" : ""}`}>
        <button className="tree-card-main" onClick={handleTitleClick}>
          {hasChildren && (
            <button
              className={`collapse-btn ${isCollapsed ? "is-collapsed" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse(node.id);
              }}
              title={isCollapsed ? "Expand" : "Collapse"}
            >
              ▼
            </button>
          )}
          {!hasChildren && <span className="collapse-spacer" />}
          <span className={`status-dot ${done ? "is-done" : "is-open"}`} />
          <span className="title-stack">
            <span className={`task-title ${node.url ? "has-link" : ""}`}>
              {node.url && <Link2 className="link-icon" size={14} />}
              {node.title}
            </span>
            <span className="task-meta">{percent}% complete</span>
          </span>
          <span className="task-badge">{completion.done}/{completion.total}</span>
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeCard
              key={child.id}
              node={child}
              selectedId={selectedId}
              depth={depth + 1}
              onSelect={onSelect}
              collapsedNodes={collapsedNodes}
              onToggleCollapse={onToggleCollapse}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

type NodeEditorProps = {
  node: TreeNode;
  canToggleDone: boolean;
  isComplete: boolean;
  onRename: (newTitle: string) => void;
  onToggleDone: (value: boolean) => void;
  onAddChild: () => void;
  onContentChange: (html: string) => void;
  onUrlChange: (url: string) => void;
  onGeneratePrompt: () => void;
  onDelete: () => void;
  onDeleteSubtree: () => void;
  onAddFile: (file: File) => void;
  onRemoveFile: (fileName: string) => void;
};

type EditorToolbarProps = {
  editor: ReturnType<typeof useEditor> | null;
};

function EditorToolbar({ editor }: EditorToolbarProps) {
  if (!editor) return null;

  const buttonClass = (isActive: boolean, tone: string) =>
    ["toolbar-btn", tone, isActive ? "is-active" : ""].filter(Boolean).join(" ");

  return (
    <div className="editor-toolbar">
      <div className="toolbar-group">
        <button className={buttonClass(editor.isActive("bold"), "is-tone-rose")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <strong>B</strong>
        </button>
        <button className={buttonClass(editor.isActive("italic"), "is-tone-coral")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <em>I</em>
        </button>
        <button className={buttonClass(editor.isActive("underline"), "is-tone-sky")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
          <u>U</u>
        </button>
        <button className={buttonClass(editor.isActive("strike"), "is-tone-slate")} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
          <s>S</s>
        </button>
      </div>

      <div className="toolbar-group">
        <button className={buttonClass(editor.isActive("heading", { level: 1 }), "is-tone-gold")} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
          H1
        </button>
        <button className={buttonClass(editor.isActive("heading", { level: 2 }), "is-tone-amber")} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
          H2
        </button>
        <button className={buttonClass(editor.isActive("heading", { level: 3 }), "is-tone-violet")} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
          H3
        </button>
      </div>

      <div className="toolbar-group">
        <button className={buttonClass(editor.isActive("bulletList"), "is-tone-mint")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
          •
        </button>
        <button className={buttonClass(editor.isActive("orderedList"), "is-tone-lime")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
          1.
        </button>
        <button className={buttonClass(editor.isActive("blockquote"), "is-tone-peach")} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">
          "
        </button>
        <button className={buttonClass(editor.isActive("codeBlock"), "is-tone-indigo")} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">
          &lt;/&gt;
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className={buttonClass(false, "is-tone-neutral")}
          onClick={() => {
            if (!editor) return;

            // Clear block-level formatting (headings, lists, etc.)
            editor.chain().focus().clearNodes().run();

            // Also remove common inline marks (bold, italic, underline, strike, code, link)
            try {
              const anyEditor: any = editor;
              const { state, view } = anyEditor;
              const { from, to } = state.selection;
              const tr = state.tr;
              const marksToRemove = ["bold", "italic", "underline", "strike", "code", "link"];

              for (const name of marksToRemove) {
                const markType = state.schema.marks[name];
                if (markType) tr.removeMark(from, to, markType);
              }

              if (tr.docChanged) view.dispatch(tr);
            } catch (e) {
              // Best-effort fallback: try unset commands if available
              try {
                editor.chain().focus().unsetBold?.().unsetItalic?.().unsetUnderline?.().unsetStrike?.().run();
              } catch (__) {
                // ignore
              }
            }
          }}
          title="Clear formatting"
        >
          <Eraser size={16} />
        </button>
      </div>
    </div>
  );
}

function NodeEditor({
  node,
  canToggleDone,
  isComplete,
  onRename,
  onToggleDone,
  onAddChild,
  onContentChange,
  onUrlChange,
  onGeneratePrompt,
  onDelete,
  onDeleteSubtree,
  onAddFile,
  onRemoveFile
}: NodeEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lowlight = createLowlight(common);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false
      }),
      Underline,
      CodeBlockLowlight.configure({
        lowlight
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https"
      })
    ],
    content: node.content,
    onUpdate: ({ editor: currentEditor }) => {
      onContentChange(currentEditor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "note-editor"
      }
    }
  });

  if (editor && node.content !== editor.getHTML()) {
    editor.commands.setContent(node.content, { emitUpdate: false } as Parameters<typeof editor.commands.setContent>[1]);
  }

  const getFileIcon = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const iconMap: { [key: string]: string } = {
      pdf: "📄",
      doc: "📝",
      docx: "📝",
      xls: "📊",
      xlsx: "📊",
      ppt: "📈",
      pptx: "📈",
      txt: "📋",
      jpg: "🖼️",
      jpeg: "🖼️",
      png: "🖼️",
      gif: "🖼️",
      mp3: "🎵",
      mp4: "🎬",
      zip: "🗂️"
    };
    return iconMap[ext] || <Paperclip size={16} />;
  };

  const renderAttachmentIcon = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase() || "";

    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext)) {
      return <FileImage size={16} />;
    }

    if (["mp4", "mov", "webm", "mkv"].includes(ext)) {
      return <Film size={16} />;
    }

    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
      return <FileArchive size={16} />;
    }

    if (["js", "ts", "tsx", "jsx", "json", "css", "html", "md", "xml"].includes(ext)) {
      return <FileCode2 size={16} />;
    }

    if (["txt", "pdf", "doc", "docx"].includes(ext)) {
      return <FileText size={16} />;
    }

    return <File size={16} />;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  return (
    <section className="editor-shell">
      <header className="editor-header">
        <div className="editor-title-group">
          <div className="editor-title-row">
            <input
              className="editor-title"
              value={node.title}
              onChange={(event) => onRename(event.target.value)}
            />
            <span className={`status-chip ${isComplete ? "is-done" : canToggleDone ? "is-open" : "is-parent"}`}>
              {isComplete ? <BadgeCheck size={14} /> : canToggleDone ? <Clock size={14} /> : <CircleCheckBig size={14} />}
              {isComplete ? "Done" : canToggleDone ? "Open" : "Parent"}
            </span>
          </div>
          <input
            type="url"
            className="editor-url"
            placeholder="Link to resource..."
            value={node.url || ""}
            onChange={(event) => onUrlChange(event.target.value)}
          />
        </div>
        <div className="editor-actions">
          <button className="ghost-btn" onClick={onAddChild}>
            <Plus size={16} /> Add child
          </button>
          <button className="ghost-btn" onClick={onGeneratePrompt} title="Generate prompt from this node and its children">
            <Copy size={16} /> Prompt
          </button>
          <button
            className={`done-btn ${isComplete ? "is-done" : ""}`}
            onClick={() => onToggleDone(!node.done)}
            disabled={!canToggleDone}
            title={canToggleDone ? "Toggle completion" : "Parent nodes complete automatically"}
          >
            {isComplete ? <RotateCcw size={16} /> : <Check size={16} />}
            {isComplete ? "Reopen" : "Complete"}
          </button>
          <button className="delete-btn" onClick={onDelete} title="Delete task (preserve subtasks)">
            <Trash2 size={16} />
          </button>
          {node.children.length > 0 && (
            <button
              className="delete-btn"
              onClick={onDeleteSubtree}
              title="Delete task and all subtasks (move subtree to trash)"
            >
              <Trash2 size={16} /> Delete subtree
            </button>
          )}
        </div>
      </header>
      {!canToggleDone && (
        <p className="editor-hint">
          This is a parent node. It will become complete automatically when all child nodes are complete.
        </p>
      )}
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />

      <div className="editor-files">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            for (const file of e.currentTarget.files || []) {
              onAddFile(file);
            }
          }}
        />
        <button 
          className="file-add-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach files"
        >
          <Paperclip size={16} /> Attach files
        </button>
        {node.files.length > 0 && (
          <div className="file-attachments">
            {node.files.map((file) => (
              <div key={file.name} className="file-attachment">
                <a
                  href={file.data}
                  download={file.name}
                  className="file-attachment-link"
                  title={`${file.name} (${formatFileSize(file.size)})`}
                >
                  <span className="file-attachment-icon">{renderAttachmentIcon(file.name)}</span>
                  <span className="file-attachment-name">{file.name}</span>
                </a>
                <button
                  className="file-attachment-remove"
                  onClick={() => onRemoveFile(file.name)}
                  title="Remove file"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const filterNodesBySearch = (node: TreeNode, query: string): TreeNode | null => {
  const lowerQuery = query.toLowerCase();
  const matchesTitle = node.title.toLowerCase().includes(lowerQuery);
  const matchesContent = node.content.toLowerCase().includes(lowerQuery);
  const matches = matchesTitle || matchesContent;

  const filteredChildren: TreeNode[] = [];
  for (const child of node.children) {
    const filtered = filterNodesBySearch(child, query);
    if (filtered) {
      filteredChildren.push(filtered);
    }
  }

  if (matches || filteredChildren.length > 0) {
    return {
      ...node,
      children: filteredChildren
    };
  }

  return null;
};

const searchAllProjects = (projects: Project[], query: string) => {
  if (!query.trim()) return null;

  const results: Array<{ projectId: string; projectName: string; node: TreeNode }> = [];

  for (const project of projects) {
    const filtered = filterNodesBySearch(project.tree, query);
    if (filtered) {
      results.push({
        projectId: project.id,
        projectName: project.name,
        node: filtered
      });
    }
  }

  return results.length > 0 ? results : null;
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState(initialProjects[0].id);
  const [selectedNodeId, setSelectedNodeId] = useState(initialProjects[0].tree.id);
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("loading");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("checking");
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [showTrash, setShowTrash] = useState(false);
  const [showCompletedProjects, setShowCompletedProjects] = useState(true);
  const [showDeletedProjects, setShowDeletedProjects] = useState(true);
  const [projectPanelWidth, setProjectPanelWidth] = useState(300);
  const [isResizingProjectPanel, setIsResizingProjectPanel] = useState(false);
  const [promptNodeId, setPromptNodeId] = useState<string | null>(null);
  const [promptCopyState, setPromptCopyState] = useState<"idle" | "copied" | "error">("idle");
  const saveTimeoutRef = useRef<number | null>(null);
  const promptCopyTimeoutRef = useRef<number | null>(null);
  const projectPanelResizeStartXRef = useRef(0);
  const projectPanelResizeStartWidthRef = useRef(300);

  const refreshUpdateStatus = async () => {
    setUpdateStatus("checking");
    setUpdateMessage("Checking GitHub releases...");
    setUpdateProgress(0);

    try {
      const update = await check({ timeout: 10000 });

      if (update) {
        setAvailableUpdate(update);
        setUpdateStatus("available");
        setUpdateMessage(update.body?.trim() ? update.body.trim() : `Version ${update.version} is available.`);
        return;
      }

      setAvailableUpdate(null);
      setUpdateStatus("idle");
      setUpdateMessage("");
    } catch (error) {
      console.warn("Update check failed", error);
      setAvailableUpdate(null);
      setUpdateStatus("idle");
      setUpdateMessage("");
    }
  };

  const installAvailableUpdate = async () => {
    if (!availableUpdate || updateStatus === "downloading") return;

    setUpdateStatus("downloading");
    setUpdateMessage(`Downloading ${availableUpdate.version}...`);
    setUpdateProgress(0);

    try {
      let downloaded = 0;
      let contentLength = 0;

      await availableUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength;
            downloaded = 0;
            setUpdateProgress(0);
            setUpdateMessage(`Downloading ${availableUpdate.version}...`);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              setUpdateProgress(Math.round((downloaded / contentLength) * 100));
            }
            break;
          case "Finished":
            setUpdateProgress(100);
            setUpdateMessage("Installing update...");
            break;
        }
      });

      setUpdateStatus("installed");
      setUpdateMessage(`Version ${availableUpdate.version} installed. Restart the app to finish.`);
    } catch (error) {
      console.error("Failed to install update", error);
      setUpdateStatus("error");
      setUpdateMessage(error instanceof Error ? error.message : "Failed to install update.");
    }
  };

  useEffect(() => {
    if (!isResizingProjectPanel) return;

    const minWidth = 240;
    const maxWidth = Math.floor(window.innerWidth / 2);

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - projectPanelResizeStartXRef.current;
      const nextWidth = projectPanelResizeStartWidthRef.current + delta;
      setProjectPanelWidth(Math.min(maxWidth, Math.max(minWidth, nextWidth)));
    };

    const handlePointerUp = () => {
      setIsResizingProjectPanel(false);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingProjectPanel]);

  const startProjectPanelResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    projectPanelResizeStartXRef.current = event.clientX;
    projectPanelResizeStartWidthRef.current = projectPanelWidth;
    setIsResizingProjectPanel(true);
  };

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      if (!supportsOpfs()) {
        if (!cancelled) {
          setStorageStatus("error");
          setIsHydrated(true);
        }
        return;
      }

      try {
        const saved = await loadWorkspaceFromFiles();

        if (!cancelled && saved && saved.projects.length > 0) {
          setProjects(saved.projects);
          setActiveProjectId(saved.activeProjectId);
          setSelectedNodeId(saved.selectedNodeId);
        }

        if (!cancelled) {
          setStorageStatus("saved");
          setIsHydrated(true);
        }
      } catch (error) {
        console.error("Failed to load workspace data", error);
        if (!cancelled) {
          setStorageStatus("error");
          setIsHydrated(true);
        }
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkForUpdate = async () => {
      try {
        const update = await check({ timeout: 10000 });

        if (cancelled) return;

        if (update) {
          setAvailableUpdate(update);
          setUpdateStatus("available");
          setUpdateMessage(update.body?.trim() ? update.body.trim() : `Version ${update.version} is available.`);
          return;
        }

        setAvailableUpdate(null);
        setUpdateStatus("idle");
        setUpdateMessage("");
      } catch (error) {
        if (cancelled) return;
        setAvailableUpdate(null);
        setUpdateStatus("idle");
        setUpdateMessage("");
      }
    };

    void checkForUpdate();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeProject = useMemo(
    () =>
      projects.find((project) => project.id === activeProjectId && project.deleted !== true) ??
      projects.find((project) => project.deleted !== true) ??
      projects[0],
    [projects, activeProjectId]
  );

  const selectedNode = useMemo(
    () => findNodeById(activeProject.tree, selectedNodeId) ?? activeProject.tree,
    [activeProject, selectedNodeId]
  );

  const promptNode = useMemo(
    () => (promptNodeId ? findNodeById(activeProject.tree, promptNodeId) : null),
    [activeProject.tree, promptNodeId]
  );

  const promptText = useMemo(() => (promptNode ? buildPromptFromNode(promptNode) : ""), [promptNode]);

  const projectViews = useMemo(
    () =>
      projects.map((project) => ({
        project,
        percent: getProjectCompletionPercent(project)
      })),
    [projects]
  );

  const visibleProjectViews = useMemo(
    () => projectViews.filter((entry) => !entry.project.deleted),
    [projectViews]
  );

  const activeProjectViews = useMemo(
    () => visibleProjectViews.filter((entry) => entry.percent < 100),
    [visibleProjectViews]
  );

  const completedProjectViews = useMemo(
    () => visibleProjectViews.filter((entry) => entry.percent >= 100),
    [visibleProjectViews]
  );

  const deletedProjectViews = useMemo(
    () => projectViews.filter((entry) => entry.project.deleted),
    [projectViews]
  );

  const sortedActiveProjectViews = useMemo(
    () => [...activeProjectViews].sort((left, right) => right.percent - left.percent),
    [activeProjectViews]
  );

  const sortedCompletedProjectViews = useMemo(
    () => [...completedProjectViews].sort((left, right) => right.percent - left.percent),
    [completedProjectViews]
  );

  const sortedDeletedProjectViews = useMemo(
    () => [...deletedProjectViews].sort((left, right) => right.percent - left.percent),
    [deletedProjectViews]
  );

  const displayTree = activeProject.tree;

  const globalSearchResults = useMemo(() => {
    if (!searchQuery.trim()) return null;
    
    return searchAllProjects(projects, searchQuery);
  }, [projects, searchQuery]);

  useEffect(() => {
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    if (!isHydrated) return;

    setStorageStatus("saving");
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        await saveWorkspaceToFiles({
          projects,
          activeProjectId,
          selectedNodeId
        });
        setStorageStatus("saved");
      } catch (error) {
        console.error("Failed to save workspace data", error);
        setStorageStatus("error");
      }
    }, 350);

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [projects, activeProjectId, selectedNodeId, isHydrated]);

  useEffect(() => {
    if (promptCopyTimeoutRef.current !== null) {
      window.clearTimeout(promptCopyTimeoutRef.current);
      promptCopyTimeoutRef.current = null;
    }

    if (!promptNode) {
      setPromptCopyState("idle");
    }
  }, [promptNode]);

  useEffect(() => {
    return () => {
      if (promptCopyTimeoutRef.current !== null) {
        window.clearTimeout(promptCopyTimeoutRef.current);
      }
    };
  }, []);

  const projectStats = useMemo(() => subtreeCompletion(activeProject.tree), [activeProject]);
  const projectPercent = Math.round((projectStats.done / projectStats.total) * 100);
  const canDeleteCurrentProject = visibleProjectViews.length > 1;

  const updateActiveProjectTree = (updater: (tree: TreeNode) => TreeNode) => {
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              tree: updater(project.tree)
            }
          : project
      )
    );
  };

  const addProject = () => {
    const root = createNode("New project root");
    const newProject: Project = {
      id: crypto.randomUUID(),
      name: `Project ${projects.length + 1}`,
      tree: root,
      trash: [],
      deleted: false
    };

    setProjects((current) => [...current, newProject]);
    setActiveProjectId(newProject.id);
    setSelectedNodeId(root.id);
  };

  const renameProject = (projectId: string, name: string) => {
    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) return project;

        const nextTree = { ...project.tree, title: name, content: setTitleInContent(project.tree.content, name) };
        return { ...project, name, tree: nextTree };
      })
    );
  };

  const deleteProject = (projectId: string) => {
    const targetProject = projects.find((project) => project.id === projectId && !project.deleted);
    if (!targetProject || !canDeleteCurrentProject) return;

    const nextActiveProject =
      visibleProjectViews.find((entry) => entry.project.id !== projectId)?.project ??
      visibleProjectViews[0]?.project;

    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              deleted: true
            }
          : project
      )
    );

    if (activeProjectId === projectId && nextActiveProject) {
      setActiveProjectId(nextActiveProject.id);
      setSelectedNodeId(nextActiveProject.tree.id);
    }
  };

  const restoreProject = (projectId: string) => {
    const restored = projects.find((project) => project.id === projectId);
    if (!restored) return;

    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              deleted: false
            }
          : project
      )
    );

    setActiveProjectId(projectId);
    setSelectedNodeId(restored.tree.id);
  };

  const emptyDeletedProjects = () => {
    setProjects((current) => current.filter((project) => !project.deleted));

    if (!projects.some((project) => project.id === activeProjectId && project.deleted)) return;

    const nextActive = projects.find((project) => !project.deleted);
    if (nextActive) {
      setActiveProjectId(nextActive.id);
      setSelectedNodeId(nextActive.tree.id);
    }
  };

  const addChildToSelected = () => {
    const child = createNode("New task");

    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        children: [...node.children, child]
      }))
    );

    setSelectedNodeId(child.id);
  };

  const toggleNodeDone = (value: boolean) => {
    if (selectedNode.children.length > 0) return;

    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        done: value
      }))
    );
  };

  const renameNode = (title: string) => {
    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        title,
        content: setTitleInContent(node.content, title)
      }))
    );
  };

  const updateNodeContent = (content: string) => {
    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        content
      }))
    );
  };

  const updateNodeUrl = (url: string) => {
    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        url: url.trim() || undefined
      }))
    );
  };

  const addFileToNode = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = event.target?.result as string;
      updateActiveProjectTree((tree) =>
        updateNodeById(tree, selectedNode.id, (node) => ({
          ...node,
          files: [
            ...node.files,
            {
              name: file.name,
              size: file.size,
              data
            }
          ]
        }))
      );
    };
    reader.readAsDataURL(file);
  };

  const removeFileFromNode = (fileName: string) => {
    updateActiveProjectTree((tree) =>
      updateNodeById(tree, selectedNode.id, (node) => ({
        ...node,
        files: node.files.filter((f) => f.name !== fileName)
      }))
    );
  };

  const openPrompt = () => {
    setPromptNodeId(selectedNode.id);
  };

  const closePrompt = () => {
    setPromptNodeId(null);
    setPromptCopyState("idle");
  };

  const copyPromptToClipboard = async () => {
    if (!promptText) return;

    try {
      await navigator.clipboard.writeText(promptText);
      setPromptCopyState("copied");

      if (promptCopyTimeoutRef.current !== null) {
        window.clearTimeout(promptCopyTimeoutRef.current);
      }

      promptCopyTimeoutRef.current = window.setTimeout(() => {
        setPromptCopyState("idle");
        promptCopyTimeoutRef.current = null;
      }, 1800);
    } catch (error) {
      console.error("Failed to copy prompt", error);
      setPromptCopyState("error");
    }
  };

  const deleteNode = (nodeId: string) => {
    const location = findNodeLocationById(activeProject.tree, nodeId);
    if (!location) return;

    if (location.parentId === null) {
      window.alert("The root node cannot be deleted.");
      return;
    }

    const confirmed = window.confirm(
      location.node.children.length > 0
        ? `Delete "${location.node.title}"? Its subtasks will stay in the tree and the task itself will move to trash.`
        : `Delete "${location.node.title}" and move it to trash?`
    );

    if (!confirmed) return;

    const removeNodePreservingChildren = (node: TreeNode, targetId: string): TreeNode => {
      const nextChildren: TreeNode[] = [];

      for (const child of node.children) {
        if (child.id === targetId) {
          nextChildren.push(...child.children);
          continue;
        }

        nextChildren.push(removeNodePreservingChildren(child, targetId));
      }

      return {
        ...node,
        children: nextChildren
      };
    };

    updateActiveProjectTree((tree) => {
      return removeNodePreservingChildren(tree, nodeId);
    });

    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              trash: [
                ...project.trash,
                {
                  node: stripNodeChildren(location.node),
                  parentId: location.parentId,
                  index: location.index
                }
              ]
            }
          : project
      )
    );

    setSelectedNodeId(location.parentId ?? activeProject.tree.id);
  };

  const deleteSubtree = (nodeId: string) => {
    const location = findNodeLocationById(activeProject.tree, nodeId);
    if (!location) return;

    if (location.parentId === null) {
      window.alert("The root node cannot be deleted.");
      return;
    }

    const confirmed = window.confirm(
      `Delete "${location.node.title}" and ALL its subtasks? This will move the entire subtree to trash.`
    );
    if (!confirmed) return;

    const removeEntire = (node: TreeNode, targetId: string): TreeNode | null => {
      const newChildren: TreeNode[] = [];
      let removed: TreeNode | null = null;

      for (const child of node.children) {
        if (child.id === targetId) {
          removed = child;
        } else {
          const result = removeEntire(child, targetId);
          if (result === null) {
            newChildren.push(child);
          } else {
            removed = result;
          }
        }
      }

      if (removed) {
        return { ...node, children: newChildren };
      }

      return null;
    };

    const toDelete = findNodeById(activeProject.tree, nodeId);
    if (!toDelete) return;

    updateActiveProjectTree((tree) => {
      const result = removeEntire(tree, nodeId);
      return result ?? tree;
    });

    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              trash: [
                ...project.trash,
                {
                  node: toDelete,
                  parentId: location.parentId,
                  index: location.index
                }
              ]
            }
          : project
      )
    );

    setSelectedNodeId(location.parentId ?? activeProject.tree.id);
  };

  const restoreFromTrash = (nodeId: string) => {
    const toRestore = activeProject.trash.find((entry) => entry.node.id === nodeId);
    if (!toRestore) return;

    updateActiveProjectTree((tree) => {
      if (toRestore.parentId) {
        const inserted = insertNodeIntoTree(tree, toRestore.parentId, toRestore.node, toRestore.index);
        if (inserted.inserted) {
          return inserted.tree;
        }
      }

      const nextChildren = [...tree.children];
      const safeIndex = Math.min(Math.max(toRestore.index, 0), nextChildren.length);
      nextChildren.splice(safeIndex, 0, toRestore.node);
      return {
        ...tree,
        children: nextChildren
      };
    });

    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              trash: project.trash.filter((entry) => entry.node.id !== nodeId)
            }
          : project
      )
    );
  };

  const emptyTrash = () => {
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProject.id
          ? {
              ...project,
              trash: []
            }
          : project
      )
    );
  };

  if (!isHydrated) {
    return (
      <div className="loading-screen" aria-busy="true" aria-live="polite">
        <div className="loading-card">
          <p className="loading-kicker">Arbory</p>
          <h1>Loading your workspace</h1>
          <p>Preparing notes, projects and saved state.</p>
          <div className="loading-bar" />
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${isResizingProjectPanel ? "is-resizing-project-panel" : ""}`} style={{ ["--project-panel-width" as string]: `${projectPanelWidth}px` }}>
      <aside className="project-panel">
        <div className="panel-header">
          <div className="panel-brand-row">
            <div className="panel-brand-title">
              <h1>Arbory</h1>
            </div>
          </div>
          <button className="solid-btn" onClick={addProject}>
            <Plus size={16} /> New project
          </button>
        </div>

        {updateStatus !== "idle" && (
          <div className={`update-banner update-banner-${updateStatus}`}>
            <div className="update-banner-head">
              <div>
                <p className="meta-label">App updates</p>
                <strong>
                  {updateStatus === "checking" && "Checking GitHub releases"}
                  {updateStatus === "available" && `Version ${availableUpdate?.version} is ready`}
                  {updateStatus === "downloading" && `Installing ${availableUpdate?.version}`}
                  {updateStatus === "installed" && "Update installed"}
                  {updateStatus === "error" && "Update check failed"}
                </strong>
              </div>
              <span
                className={`status-chip ${
                  updateStatus === "available"
                    ? "is-open"
                    : updateStatus === "downloading"
                      ? "is-parent"
                      : updateStatus === "installed"
                        ? "is-done"
                        : "is-error"
                }`}
              >
                {updateStatus === "checking"
                  ? "Checking"
                  : updateStatus === "available"
                    ? "Update ready"
                    : updateStatus === "downloading"
                      ? `${updateProgress}%`
                      : updateStatus === "installed"
                        ? "Installed"
                        : "Retry"}
              </span>
            </div>
            {updateMessage && <p className="update-banner-copy">{updateMessage}</p>}
            {updateStatus === "available" && availableUpdate && (
              <div className="update-banner-actions">
                <button className="solid-btn" onClick={installAvailableUpdate}>
                  Install update
                </button>
                <button className="ghost-btn" onClick={refreshUpdateStatus}>
                  Check again
                </button>
              </div>
            )}
            {updateStatus === "downloading" && (
              <div className="update-progress-track" aria-hidden="true">
                <span className="update-progress-fill" style={{ width: `${updateProgress}%` }} />
              </div>
            )}
            {updateStatus === "error" && (
              <div className="update-banner-actions">
                <button className="ghost-btn" onClick={refreshUpdateStatus}>
                  Retry
                </button>
              </div>
            )}
          </div>
        )}

        <div className="project-search">
          <input
            type="search"
            className="search-input"
            placeholder="Search all notes..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {globalSearchResults && searchQuery.trim() && (
            <div className="search-results search-results-sidebar">
              <p className="search-results-header">
                Found in {globalSearchResults.length} project{globalSearchResults.length !== 1 ? "s" : ""}
              </p>
              {globalSearchResults.map((result) => (
                <div key={result.projectId} className="search-result-group">
                  <button
                    className="search-result-project"
                    onClick={() => {
                      setActiveProjectId(result.projectId);
                      setSelectedNodeId(result.node.id);
                    }}
                  >
                    {result.projectName}
                  </button>
                  <ul className="tree-root search-result-tree">
                    <TreeCard
                      node={result.node}
                      selectedId={selectedNode.id}
                      depth={0}
                      onSelect={(nodeId) => {
                        setActiveProjectId(result.projectId);
                        setSelectedNodeId(nodeId);
                      }}
                      collapsedNodes={collapsedNodes}
                      onToggleCollapse={(nodeId) => {
                        setCollapsedNodes((prev) => {
                          const next = new Set(prev);
                          if (next.has(nodeId)) {
                            next.delete(nodeId);
                          } else {
                            next.add(nodeId);
                          }
                          return next;
                        });
                      }}
                    />
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="project-list">
          {sortedActiveProjectViews.map(({ project, percent }) => {
            const active = project.id === activeProject.id;

            return (
              <div
                key={project.id}
                className={`project-pill ${active ? "is-active" : ""}`}
                onClick={() => {
                  setActiveProjectId(project.id);
                  setSelectedNodeId(project.tree.id);
                }}
                role="button"
                tabIndex={0}
              >
                <input
                  value={project.name}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => renameProject(project.id, event.target.value)}
                />
                <span>{percent}%</span>
                <button
                  className="project-delete-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteProject(project.id);
                  }}
                  title="Move project to trash"
                  disabled={!canDeleteCurrentProject}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>

        {sortedCompletedProjectViews.length > 0 && (
          <div className="project-section project-section-completed">
            <button
              className="project-section-toggle"
              onClick={() => setShowCompletedProjects(!showCompletedProjects)}
            >
              <span>Completed projects ({sortedCompletedProjectViews.length})</span>
              <ChevronDown className={showCompletedProjects ? "is-open" : ""} size={16} />
            </button>

            {showCompletedProjects && (
              <div className="project-list project-list-island">
                {sortedCompletedProjectViews.map(({ project, percent }) => {
                  const active = project.id === activeProject.id;

                  return (
                    <div
                      key={project.id}
                      className={`project-pill ${active ? "is-active" : ""}`}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setSelectedNodeId(project.tree.id);
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <input
                        value={project.name}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => renameProject(project.id, event.target.value)}
                      />
                      <span>{percent}%</span>
                      <button
                        className="project-delete-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteProject(project.id);
                        }}
                        title="Move project to trash"
                        disabled={!canDeleteCurrentProject}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="project-progress">
          <div className="ring" style={{ ["--value" as string]: `${projectPercent}%` }} />
          <div>
            <p className="meta-label">Current project progress</p>
            <strong>{projectStats.done}/{projectStats.total} nodes complete</strong>
          </div>
        </div>

        {activeProject.trash.length > 0 && (
          <div className="trash-section">
            <button
              className="trash-toggle"
              onClick={() => setShowTrash(!showTrash)}
            >
              <Trash2 size={16} /> Trash ({activeProject.trash.length})
            </button>

            {showTrash && (
              <div className="trash-list">
                {activeProject.trash.map((entry) => (
                  <div key={entry.node.id} className="trash-item">
                    <span className="trash-title">{entry.node.title}</span>
                    <div className="trash-actions">
                      <button
                        className="trash-restore"
                        onClick={() => restoreFromTrash(entry.node.id)}
                        title="Restore"
                      >
                        ↩️
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="empty-trash-btn"
                  onClick={emptyTrash}
                >
                  Empty trash
                </button>
              </div>
            )}
          </div>
        )}

        {sortedDeletedProjectViews.length > 0 && (
          <div className="project-section project-section-trash">
            <button
              className="project-section-toggle"
              onClick={() => setShowDeletedProjects(!showDeletedProjects)}
            >
              <span>Project trash ({sortedDeletedProjectViews.length})</span>
              <ChevronDown className={showDeletedProjects ? "is-open" : ""} size={16} />
            </button>

            {showDeletedProjects && (
              <div className="project-list project-list-island">
                {sortedDeletedProjectViews.map(({ project, percent }) => (
                  <div key={project.id} className="project-pill project-pill-is-trash">
                    <input value={project.name} readOnly />
                    <span>{percent}%</span>
                    <button
                      className="project-restore-btn"
                      onClick={() => restoreProject(project.id)}
                      title="Restore project"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                ))}
                <button className="empty-trash-btn" onClick={emptyDeletedProjects}>
                  Empty project trash
                </button>
              </div>
            )}
          </div>
        )}
        <div
          className="panel-resizer"
          onPointerDown={startProjectPanelResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left panel"
        />
      </aside>

      <main className="tree-panel">
        <header className="tree-header">
          <h2>{activeProject.name}</h2>
        </header>

        <ul className="tree-root">
          <TreeCard
            node={displayTree}
            selectedId={selectedNode.id}
            depth={0}
            onSelect={setSelectedNodeId}
            collapsedNodes={collapsedNodes}
            onToggleCollapse={(nodeId) => {
              setCollapsedNodes((prev) => {
                const next = new Set(prev);
                if (next.has(nodeId)) {
                  next.delete(nodeId);
                } else {
                  next.add(nodeId);
                }
                return next;
              });
            }}
          />
        </ul>
      </main>

      <section className="editor-panel">
        <NodeEditor
          node={selectedNode}
          canToggleDone={selectedNode.children.length === 0}
          isComplete={isNodeComplete(selectedNode)}
          onRename={renameNode}
          onToggleDone={toggleNodeDone}
          onAddChild={addChildToSelected}
          onContentChange={updateNodeContent}
          onUrlChange={updateNodeUrl}
          onGeneratePrompt={openPrompt}
          onDelete={() => deleteNode(selectedNode.id)}
          onDeleteSubtree={() => deleteSubtree(selectedNode.id)}
          onAddFile={addFileToNode}
          onRemoveFile={removeFileFromNode}
        />
      </section>

      {promptNodeId !== null && (
        <div className="prompt-modal-backdrop" role="presentation" onClick={closePrompt}>
          <div
            className="prompt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-modal-title"
            aria-describedby="prompt-modal-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="prompt-modal-header">
              <div>
                <p className="meta-label" id="prompt-modal-description">Generated prompt</p>
                <h3 id="prompt-modal-title">{promptNode ? promptNode.title : "(node not found)"}</h3>
              </div>
              <button className="prompt-modal-close" onClick={closePrompt} aria-label="Close prompt dialog">
                <X size={16} />
              </button>
            </div>

            <textarea className="prompt-textarea" readOnly value={promptNode ? promptText : "Unable to build prompt: node not found in current project."} />

            <div className="prompt-modal-actions">
              <button className="solid-btn" onClick={copyPromptToClipboard} disabled={!promptNode || !promptText}>
                <Copy size={16} />
                {promptCopyState === "copied" ? "Copied" : promptCopyState === "error" ? "Copy failed" : "Copy prompt"}
              </button>
              <button className="ghost-btn" onClick={closePrompt}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
