import { Badge, Button } from "./ui.js";
import type {
  DependencyValidationActivityItem,
  NotificationItem,
  PersonSummary,
  ProjectSummary
} from "./api-client.js";
import {
  buildRepositoryNavigationContext,
  canManageProjectArchive,
  type ArchiveRejection,
  type RepositoryNavigationContext
} from "./board-view-model.js";

export interface ProjectArchiveRejection extends ArchiveRejection {
  projectId: string;
}

function formatArchiveTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Multi-project dashboard: one card per project (repositories + task counts),
 * a cross-project people summary, and lightweight unread dependency cues.
 * Archived projects live in their own collapsed, read-only section below the
 * cards; `projects` must already exclude them so the KPIs only count active
 * work.
 */
export function ProjectDashboard({
  projects,
  archivedProjects = [],
  people,
  notifications,
  validationActivities,
  activeOwner,
  actorOwner,
  overviewMode,
  onOpenRepository,
  onFilterOwner,
  onToggleOverview,
  onBackToBoard,
  onShareProject,
  onAcceptProjectInvite,
  onArchiveProject,
  onUnarchiveProject,
  archiveRejection = null,
  busyProjectId = null
}: {
  projects: readonly ProjectSummary[];
  archivedProjects?: readonly ProjectSummary[];
  people: readonly PersonSummary[];
  notifications: readonly NotificationItem[];
  validationActivities: readonly DependencyValidationActivityItem[];
  /** Owner whose dashboard is shown (may be another owner, read-only). */
  activeOwner: string;
  /** Board-paired identity; archive controls require activeOwner === actorOwner. */
  actorOwner?: string;
  overviewMode: boolean;
  onOpenRepository: (context: RepositoryNavigationContext) => void;
  onFilterOwner: (owner: string) => void;
  onToggleOverview: () => void;
  onBackToBoard: () => void;
  onShareProject?: (project: ProjectSummary) => void;
  onAcceptProjectInvite?: () => void;
  onArchiveProject?: (project: ProjectSummary) => void;
  onUnarchiveProject?: (project: ProjectSummary) => void;
  archiveRejection?: ProjectArchiveRejection | null;
  busyProjectId?: string | null;
}) {
  const archiveContext = {
    actorOwner: actorOwner ?? "",
    targetOwner: activeOwner,
    overviewMode
  };
  const canManageArchive = (project: ProjectSummary): boolean => (
    actorOwner !== undefined && canManageProjectArchive(project, archiveContext)
  );
  const unreadNotifications = notifications.filter((n) => n.read_at === null);
  const unreadValidations = validationActivities.filter((activity) => activity.read_at === null);
  const unreadCount = unreadNotifications.length + unreadValidations.length;
  const unreadByRepository = new Map<string, { count: number; hasCancellation: boolean }>();
  for (const notification of unreadNotifications) {
    const current = unreadByRepository.get(notification.repository_id) ?? {
      count: 0,
      hasCancellation: false
    };
    unreadByRepository.set(notification.repository_id, {
      count: current.count + 1,
      hasCancellation: current.hasCancellation || notification.upstream_status === "cancelled"
    });
  }
  for (const activity of unreadValidations) {
    const current = unreadByRepository.get(activity.repository_id) ?? {
      count: 0,
      hasCancellation: false
    };
    unreadByRepository.set(activity.repository_id, {
      count: current.count + 1,
      hasCancellation: current.hasCancellation || activity.status === "rejected"
    });
  }

  const totalTasks = projects.reduce(
    (sum, project) => sum + project.repositories.reduce((s, r) => s + r.task_count, 0), 0
  );
  const attention = projects.reduce((total, project) => {
    for (const repository of project.repositories) {
      total.pendingAcceptance += repository.attention.pending_acceptance;
      total.blocked += repository.attention.blocked;
      total.stale += repository.attention.stale;
    }
    return total;
  }, { pendingAcceptance: 0, blocked: 0, stale: 0 });

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h2 className="dashboard-title">
            {overviewMode ? "项目总览" : `${activeOwner} 的仪表盘`}
          </h2>
          {unreadCount > 0 && (
            <Badge
              variant={unreadNotifications.some((n) => n.upstream_status === "cancelled")
                || unreadValidations.some((activity) => activity.status === "rejected")
                ? "destructive"
                : "info"}
              size="sm"
            >
              {unreadCount} 条依赖提醒
            </Badge>
          )}
          {overviewMode && (
            <span className="dashboard-overview-stats">
              {projects.length} 项目 · {totalTasks} 任务 · {people.filter(p => p.owner !== null).length} 成员
            </span>
          )}
        </div>
        <div className="dashboard-header-actions">
          <Button
            variant={overviewMode ? "default" : "outline"}
            size="sm"
            onClick={onToggleOverview}
          >
            {overviewMode ? "个人视角" : "全局总览"}
          </Button>
          <Button variant="outline" size="sm" onClick={onBackToBoard}>
            返回看板
          </Button>
          {onAcceptProjectInvite !== undefined && (
            <Button variant="outline" size="sm" onClick={onAcceptProjectInvite}>
              加入项目
            </Button>
          )}
        </div>
      </header>

      <section className="dashboard-kpis" aria-label="任务行动摘要">
        <div className="dashboard-kpi">
          <span className="dashboard-kpi-value">{totalTasks}</span>
          <span className="dashboard-kpi-label">全部任务</span>
        </div>
        <div className="dashboard-kpi dashboard-kpi-attention">
          <span className="dashboard-kpi-value">{attention.pendingAcceptance}</span>
          <span className="dashboard-kpi-label">待验收</span>
        </div>
        <div className="dashboard-kpi dashboard-kpi-danger">
          <span className="dashboard-kpi-value">{attention.blocked}</span>
          <span className="dashboard-kpi-label">受阻</span>
        </div>
        <div className="dashboard-kpi dashboard-kpi-warning">
          <span className="dashboard-kpi-value">{attention.stale}</span>
          <span className="dashboard-kpi-label">久未更新</span>
        </div>
      </section>

      <div className="dashboard-grid">
        {projects.map((project) => {
          const projectRepoIds = new Set(project.repositories.map((r) => r.repository_id));
          const projectPeople = overviewMode
            ? people.filter((p) => p.repositories.some((r) => projectRepoIds.has(r)))
            : [];
          return (
            <section key={project.project_id} className="dashboard-card" aria-label={project.name}>
              <header className="dashboard-card-header">
                <div className="dashboard-card-title-group">
                  <span className="dashboard-card-title" title={project.name}>{project.name}</span>
                  <span className="dashboard-project-meta">
                    <span className="dashboard-project-creator">
                      <span className="dashboard-project-creator-label">项目创建人</span>
                      <Badge
                        variant={project.created_by === undefined || project.created_by === null
                          ? "secondary"
                          : "warning"}
                        size="sm"
                      >
                        {project.created_by ?? "未分配"}
                      </Badge>
                    </span>
                    {onShareProject !== undefined && project.created_by === activeOwner && (
                      <Button
                        className="dashboard-share-button"
                        variant="outline"
                        size="sm"
                        onClick={() => onShareProject(project)}
                      >
                        分享项目
                      </Button>
                    )}
                    {onArchiveProject !== undefined && canManageArchive(project) && (
                      <Button
                        className="dashboard-archive-button"
                        variant="ghost"
                        size="sm"
                        disabled={busyProjectId === project.project_id}
                        title="归档后项目从切换器中移除，数据全部保留，可在下方「已归档项目」还原"
                        onClick={() => onArchiveProject(project)}
                      >
                        归档
                      </Button>
                    )}
                  </span>
                </div>
                <span className="dashboard-card-header-actions">
                  <Badge className="dashboard-repository-count" variant="secondary" size="sm">
                    {project.repositories.length} 仓库
                  </Badge>
                </span>
              </header>
              {archiveRejection !== null && archiveRejection.projectId === project.project_id && (
                <div role="alert" className="dashboard-archive-rejection">
                  <p>无法归档：{archiveRejection.summary}</p>
                  {archiveRejection.lines.length > 0 && (
                    <ul>
                      {archiveRejection.lines.map((line) => (
                        <li key={line} className="mono">{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <ul className="dashboard-repos">
                {project.repositories.map((repository) => {
                  const dependencyAttention = unreadByRepository.get(repository.repository_id);
                  const navigationContext = buildRepositoryNavigationContext(
                    project,
                    repository.repository_id,
                    people
                  );
                  return (
                    <li key={repository.repository_id}>
                      <button
                        type="button"
                        className="dashboard-repo"
                        onClick={() => {
                          if (navigationContext !== null) {
                            onOpenRepository(navigationContext);
                          }
                        }}
                      >
                        <span className="dashboard-repo-main">
                          <span
                            className="dashboard-repo-label dashboard-text-truncate"
                            title={repository.label}
                          >
                            {repository.label}
                          </span>
                          <span
                            className="dashboard-repo-id mono dashboard-text-truncate"
                            title={repository.repository_id}
                          >
                            {repository.repository_id}
                          </span>
                          {navigationContext !== null && navigationContext.owners.length > 0 && (
                            <span className="dashboard-repo-owner">
                              <Badge variant="accent" size="sm">
                                owner：{navigationContext.owners.join(", ")}
                              </Badge>
                            </span>
                          )}
                        </span>
                        <span className="dashboard-repo-meta">
                          <span className="dashboard-repo-attention dashboard-repo-attention-grid">
                            {repository.attention.pending_acceptance > 0 && (
                              <Badge variant="warning" size="sm">
                                待验收 {repository.attention.pending_acceptance}
                              </Badge>
                            )}
                            {repository.attention.blocked > 0 && (
                              <Badge variant="destructive" size="sm">
                                受阻 {repository.attention.blocked}
                              </Badge>
                            )}
                            {repository.attention.stale > 0 && (
                              <Badge className="dashboard-repo-overdue" variant="secondary" size="sm">
                                过期 {repository.attention.stale}
                              </Badge>
                            )}
                            {dependencyAttention !== undefined && (
                              <Badge
                                variant={dependencyAttention.hasCancellation ? "destructive" : "info"}
                                size="sm"
                              >
                                依赖 {dependencyAttention.count}
                              </Badge>
                            )}
                            <Badge className="dashboard-repo-task-count" variant="secondary" size="sm">
                              任务 {repository.task_count}
                            </Badge>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {projectPeople.length > 0 && (
                <div className="dashboard-people">
                  <span className="dashboard-people-label">任务执行人</span>
                  {projectPeople.map((person) => {
                    const projectTaskCount = project.repositories.reduce(
                      (sum, repo) => sum + (person.task_counts[repo.repository_id] ?? 0), 0
                    );
                    return (
                      <button
                        key={person.owner ?? "_null"}
                        type="button"
                        className={`dashboard-person${activeOwner === person.owner ? " active" : ""}`}
                        disabled={person.owner === null}
                        title={person.owner === null
                          ? "未分配任务没有可查看的 owner"
                          : "查看该 owner 的项目和任务；非本人任务保持只读"}
                        onClick={() => {
                          if (person.owner !== null) {
                            onFilterOwner(person.owner);
                          }
                        }}
                      >
                        <span>{person.owner ?? "未分配"}</span>
                        <Badge variant="secondary" size="sm">{projectTaskCount}</Badge>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
        {projects.length === 0 && (
          <p className="dashboard-empty">
            {archivedProjects.length > 0 ? "没有可用项目，已归档项目见下方。" : "尚未登记任何项目或仓库。"}
          </p>
        )}
      </div>

      {archivedProjects.length > 0 && (
        <details className="dashboard-archived">
          <summary className="dashboard-archived-summary">
            已归档项目（{archivedProjects.length}）
          </summary>
          <ul className="dashboard-archived-list">
            {archivedProjects.map((project) => (
              <li key={project.project_id} className="dashboard-archived-item">
                <span className="dashboard-archived-name dashboard-text-truncate" title={project.name}>
                  {project.name}
                </span>
                <span className="dashboard-archived-meta">
                  <span>创建人：{project.created_by ?? "未分配"}</span>
                  <span>{project.repositories.length} 仓库</span>
                  <span>
                    归档时间：
                    <time dateTime={project.archived_at ?? undefined} title={project.archived_at ?? undefined}>
                      {formatArchiveTime(project.archived_at)}
                    </time>
                  </span>
                  <span>归档人：{project.archived_by ?? "未知"}</span>
                </span>
                {onUnarchiveProject !== undefined && canManageArchive(project) && (
                  <Button
                    className="dashboard-restore-button"
                    variant="outline"
                    size="sm"
                    disabled={busyProjectId === project.project_id}
                    onClick={() => onUnarchiveProject(project)}
                  >
                    还原
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
