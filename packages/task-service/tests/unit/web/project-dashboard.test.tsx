import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectDashboard } from "../../../src/web/project-dashboard.js";

describe("ProjectDashboard", () => {
  it("passes project and repository owner context from a global overview repo row", () => {
    const onOpenRepository = vi.fn();
    const element = ProjectDashboard({
      projects: [{
        project_id: "project-recipe",
        name: "recipe-pipeline",
        created_by: "yorn",
        repositories: [{
          repository_id: "recipe-pipeline",
          label: "recipe-pipeline",
          task_count: 1,
          attention: { pending_acceptance: 0, blocked: 0, stale: 0 }
        }]
      }],
      people: [{
        owner: "jande",
        task_count: 1,
        repositories: ["recipe-pipeline"],
        task_counts: { "recipe-pipeline": 1 }
      }],
      notifications: [],
      validationActivities: [],
      activeOwner: "jande",
      overviewMode: true,
      onOpenRepository,
      onFilterOwner: vi.fn(),
      onToggleOverview: vi.fn(),
      onBackToBoard: vi.fn()
    });

    const findRepositoryButton = (node: ReactNode): ReactElement | null => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const match = findRepositoryButton(child);
          if (match !== null) {
            return match;
          }
        }
        return null;
      }
      if (!isValidElement(node)) {
        return null;
      }
      if (node.type === "button" && node.props.className === "dashboard-repo") {
        return node;
      }
      const children = Array.isArray(node.props.children)
        ? node.props.children
        : [node.props.children];
      for (const child of children) {
        const match = findRepositoryButton(child);
        if (match !== null) {
          return match;
        }
      }
      return null;
    };
    const button = findRepositoryButton(element);
    expect(button).not.toBeNull();

    button!.props.onClick();
    expect(onOpenRepository).toHaveBeenCalledWith({
      projectId: "project-recipe",
      repositoryId: "recipe-pipeline",
      projectCreatedBy: "yorn",
      owners: ["jande"]
    });
  });

  it("renders a session-bound project even when the owner has no tasks", () => {
    const html = renderToStaticMarkup(
      <ProjectDashboard
        projects={[{
          project_id: "project-recipe-pipeline",
          name: "recipe-pipeline",
          repositories: [{
            repository_id: "recipe-pipeline",
            label: "recipe-pipeline",
            task_count: 0,
            attention: {
              pending_acceptance: 0,
              blocked: 0,
              stale: 0
            }
          }]
        }]}
        people={[]}
        notifications={[]}
        validationActivities={[]}
        activeOwner="yorn"
        overviewMode={false}
        onOpenRepository={vi.fn()}
        onFilterOwner={vi.fn()}
        onToggleOverview={vi.fn()}
        onBackToBoard={vi.fn()}
      />
    );

    expect(html).toContain("yorn 的仪表盘");
    expect(html).toContain("recipe-pipeline");
    expect(html).toContain("任务 0");
    expect(html).toContain("待验收");
    expect(html).toContain("久未更新");
    expect(html).not.toContain("尚未登记任何项目或仓库");
  });

  it("renders action counts and lightweight dependency notification cues", () => {
    const html = renderToStaticMarkup(
      <ProjectDashboard
        projects={[{
          project_id: "project-main",
          name: "Main",
          repositories: [{
            repository_id: "repo-main",
            label: "Main",
            task_count: 7,
            attention: {
              pending_acceptance: 2,
              blocked: 1,
              stale: 3
            }
          }]
        }]}
        people={[]}
        notifications={[{
          notification_id: "notification-1",
          owner: "jande",
          task_id: "task-downstream",
          repository_id: "repo-main",
          upstream_task_id: "task-upstream",
          upstream_title: "上游任务",
          upstream_status: "done",
          read_at: null,
          created_at: "2026-08-21T10:00:00.000Z",
          task_title: "下游任务"
        }]}
        validationActivities={[]}
        activeOwner="jande"
        overviewMode={false}
        onOpenRepository={vi.fn()}
        onFilterOwner={vi.fn()}
        onToggleOverview={vi.fn()}
        onBackToBoard={vi.fn()}
      />
    );

    expect(html).toContain("待验收 2");
    expect(html).toContain("受阻 1");
    expect(html).toContain("过期 3");
    expect(html).toContain("1 条依赖提醒");
    expect(html).toContain("依赖 1");
    expect(html).toContain("任务 7");
    expect(html).toMatch(/class="[^"]*bg-info-soft[^"]*"[^>]*>依赖 1<\/span>/);
    expect(html).toMatch(/class="[^"]*dashboard-repo-task-count[^"]*"[^>]*>任务 7<\/span>/);
    expect(html).toMatch(/class="[^"]*dashboard-repo-overdue[^"]*"[^>]*>过期 3<\/span>/);
    expect(html).not.toContain("上游任务");
  });

  it("keeps long repository text available while marking compact layout regions", () => {
    const repositoryLabel = "repository-with-a-name-that-needs-truncation";
    const repositoryId = "repository-id-with-a-name-that-needs-truncation";
    const html = renderToStaticMarkup(
      <ProjectDashboard
        projects={[{
          project_id: "project-long-text",
          name: "Long text project",
          repositories: [{
            repository_id: repositoryId,
            label: repositoryLabel,
            task_count: 1,
            attention: {
              pending_acceptance: 1,
              blocked: 1,
              stale: 1
            }
          }]
        }]}
        people={[]}
        notifications={[]}
        validationActivities={[]}
        activeOwner="jande"
        overviewMode={false}
        onOpenRepository={vi.fn()}
        onFilterOwner={vi.fn()}
        onToggleOverview={vi.fn()}
        onBackToBoard={vi.fn()}
      />
    );

    expect(html).toContain(
      `class="dashboard-repo-label dashboard-text-truncate" title="${repositoryLabel}"`
    );
    expect(html).toContain(
      `class="dashboard-repo-id mono dashboard-text-truncate" title="${repositoryId}"`
    );
    expect(html).toContain("dashboard-repo-attention dashboard-repo-attention-grid");
    expect(html).toContain("dashboard-repo-meta");
    expect(html).toContain("任务 1");
  });

  it("keeps repository owner below main info and outside status tags", () => {
    const element = ProjectDashboard({
      projects: [{
        project_id: "project-layout",
        name: "Layout project",
        repositories: [{
          repository_id: "repo-layout",
          label: "Layout repository",
          task_count: 6,
          attention: {
            pending_acceptance: 1,
            blocked: 0,
            stale: 1
          }
        }]
      }],
      people: [{
        owner: "jande",
        task_count: 6,
        repositories: ["repo-layout"],
        task_counts: { "repo-layout": 6 }
      }],
      notifications: [],
      validationActivities: [],
      activeOwner: "jande",
      overviewMode: true,
      onOpenRepository: vi.fn(),
      onFilterOwner: vi.fn(),
      onToggleOverview: vi.fn(),
      onBackToBoard: vi.fn()
    });

    const findByClass = (node: ReactNode, className: string): ReactElement | null => {
      if (Array.isArray(node)) {
        for (const child of node) {
          const match = findByClass(child, className);
          if (match !== null) {
            return match;
          }
        }
        return null;
      }
      if (!isValidElement(node)) {
        return null;
      }
      if (node.props.className === className) {
        return node;
      }
      return findByClass(node.props.children, className);
    };
    const textContent = (node: ReactNode): string => {
      if (Array.isArray(node)) {
        return node.map(textContent).join("");
      }
      if (typeof node === "string" || typeof node === "number") {
        return String(node);
      }
      if (!isValidElement(node)) {
        return "";
      }
      return textContent(node.props.children);
    };

    const main = findByClass(element, "dashboard-repo-main");
    const attention = findByClass(element, "dashboard-repo-attention dashboard-repo-attention-grid");
    const owner = findByClass(main, "dashboard-repo-owner");
    expect(attention).not.toBeNull();
    expect(main).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(textContent(attention)).not.toContain("owner：");
    expect(textContent(owner)).toContain("owner：jande");
  });

  it("shows the project creator separately from task people in overview cards", () => {
    const html = renderToStaticMarkup(
      <ProjectDashboard
        projects={[{
          project_id: "project-owned",
          name: "Owned project",
          created_by: "jande",
          repositories: [{
            repository_id: "repo-owned",
            label: "Owned repository",
            task_count: 1,
            attention: {
              pending_acceptance: 0,
              blocked: 0,
              stale: 0
            }
          }]
        }]}
        people={[{
          owner: "task-runner",
          task_count: 1,
          repositories: ["repo-owned"],
          task_counts: { "repo-owned": 1 }
        }]}
        notifications={[]}
        validationActivities={[]}
        activeOwner="jande"
        overviewMode
        onOpenRepository={vi.fn()}
        onFilterOwner={vi.fn()}
        onToggleOverview={vi.fn()}
        onBackToBoard={vi.fn()}
      />
    );

    expect(html).toContain("项目创建人");
    expect(html).toContain("jande");
    expect(html).toContain("任务执行人");
    expect(html).toContain("task-runner");
    expect(html).toContain("owner：task-runner");
  });

  describe("project archive", () => {
    const repository = (repositoryId: string, taskCount: number) => ({
      repository_id: repositoryId,
      label: repositoryId,
      task_count: taskCount,
      attention: { pending_acceptance: 0, blocked: 0, stale: 0 }
    });
    const ownProject = {
      project_id: "project-own",
      name: "Own",
      created_by: "jande",
      archived_at: null,
      repositories: [repository("repo-own", 2)]
    };
    const legacyProject = {
      project_id: "project-legacy",
      name: "Legacy",
      created_by: null,
      archived_at: null,
      repositories: [repository("repo-legacy", 1)]
    };
    const foreignProject = {
      project_id: "project-foreign",
      name: "Foreign",
      created_by: "yorn",
      archived_at: null,
      repositories: [repository("repo-foreign", 1)]
    };
    const archivedProject = {
      project_id: "project-archived",
      name: "Shelved",
      created_by: "jande",
      archived_at: "2026-10-16T02:00:00.000Z",
      archived_by: "jande",
      repositories: [repository("repo-shelved-a", 40), repository("repo-shelved-b", 2)]
    };

    function collect(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement[] {
      if (Array.isArray(node)) {
        return node.flatMap((child) => collect(child, match));
      }
      if (!isValidElement(node)) {
        return [];
      }
      const props = node.props as { children?: ReactNode };
      return [
        ...(match(node) ? [node] : []),
        ...collect(props.children, match)
      ];
    }

    function hasClass(element: ReactElement, className: string): boolean {
      const value = (element.props as { className?: unknown }).className;
      return typeof value === "string" && value.split(" ").includes(className);
    }

    function dashboardProps(overrides: Record<string, unknown> = {}) {
      return {
        projects: [ownProject, legacyProject, foreignProject],
        archivedProjects: [archivedProject],
        people: [],
        notifications: [],
        validationActivities: [],
        activeOwner: "jande",
        actorOwner: "jande",
        overviewMode: false,
        onOpenRepository: vi.fn(),
        onFilterOwner: vi.fn(),
        onToggleOverview: vi.fn(),
        onBackToBoard: vi.fn(),
        onArchiveProject: vi.fn(),
        onUnarchiveProject: vi.fn(),
        ...overrides
      };
    }

    it("offers archive only for own and legacy projects on the actor's dashboard", () => {
      const props = dashboardProps();
      const element = ProjectDashboard(props);
      const buttons = collect(element, (node) => hasClass(node, "dashboard-archive-button"));
      expect(buttons).toHaveLength(2);
      (buttons[0]!.props as { onClick: () => void }).onClick();
      (buttons[1]!.props as { onClick: () => void }).onClick();
      expect(props.onArchiveProject).toHaveBeenNthCalledWith(1, ownProject);
      expect(props.onArchiveProject).toHaveBeenNthCalledWith(2, legacyProject);
    });

    it("renders archived projects in a separate collapsed section with restore", () => {
      const props = dashboardProps();
      const html = renderToStaticMarkup(<ProjectDashboard {...props} />);
      expect(html).toMatch(/<details class="dashboard-archived"(?![^>]*open)[^>]*>/);
      expect(html).toContain("已归档项目（1）");
      expect(html).toContain("Shelved");
      expect(html).toContain("2 仓库");
      expect(html).toContain("归档人");
      expect(html).toContain("dateTime=\"2026-10-16T02:00:00.000Z\"");
      expect(html).toContain("还原");
      // Archived projects do not render as switchable project cards.
      expect(html).not.toContain("aria-label=\"Shelved\"");
      expect(html).not.toContain("repo-shelved-a");

      const element = ProjectDashboard(props);
      const restore = collect(element, (node) => hasClass(node, "dashboard-restore-button"));
      expect(restore).toHaveLength(1);
      (restore[0]!.props as { onClick: () => void }).onClick();
      expect(props.onUnarchiveProject).toHaveBeenCalledWith(archivedProject);
    });

    it("keeps archived task counts out of the dashboard KPIs", () => {
      const html = renderToStaticMarkup(<ProjectDashboard {...dashboardProps()} />);
      expect(html).toMatch(/dashboard-kpi-value">4<\/span><span class="dashboard-kpi-label">全部任务/);
    });

    it("shows the archived section read-only without any buttons for another owner", () => {
      const props = dashboardProps({ activeOwner: "yorn" });
      const element = ProjectDashboard(props);
      expect(collect(element, (node) => hasClass(node, "dashboard-archive-button"))).toEqual([]);
      expect(collect(element, (node) => hasClass(node, "dashboard-restore-button"))).toEqual([]);
      const html = renderToStaticMarkup(<ProjectDashboard {...props} />);
      expect(html).toContain("已归档项目（1）");
      expect(html).not.toContain("还原");
    });

    it("hides restore for an archived project created by someone else", () => {
      const props = dashboardProps({
        archivedProjects: [{ ...archivedProject, created_by: "yorn" }]
      });
      const element = ProjectDashboard(props);
      expect(collect(element, (node) => hasClass(node, "dashboard-restore-button"))).toEqual([]);
    });

    it("hides archive controls in the global overview", () => {
      const element = ProjectDashboard(dashboardProps({ overviewMode: true }));
      expect(collect(element, (node) => hasClass(node, "dashboard-archive-button"))).toEqual([]);
    });

    it("shows the unfinished-task breakdown inline when an archive is rejected", () => {
      const html = renderToStaticMarkup(
        <ProjectDashboard
          {...dashboardProps({
            archiveRejection: {
              projectId: "project-own",
              summary: "仍有 1 个未结束任务：进行中 1",
              lines: ["task-1（owner：member，进行中）"]
            }
          })}
        />
      );
      expect(html).toContain("无法归档：仍有 1 个未结束任务：进行中 1");
      expect(html).toContain("task-1（owner：member，进行中）");
    });
  });
});

