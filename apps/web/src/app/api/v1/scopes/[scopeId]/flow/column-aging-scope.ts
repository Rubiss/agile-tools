import type { BoardColumnMapping } from '@agile-tools/analytics';
import type { ColumnAgingModel } from '@agile-tools/shared/contracts/api';

export function selectInScopeColumnAgingModels(
  columnAgingModels: ColumnAgingModel[],
  boardColumns: BoardColumnMapping[],
  startStatusIds: string[],
  doneStatusIds: string[],
): ColumnAgingModel[] {
  if (columnAgingModels.length === 0 || boardColumns.length === 0) return columnAgingModels;

  const modelsByColumn = new Map(columnAgingModels.map((model) => [model.columnName, model]));
  const startStatuses = new Set(startStatusIds);
  const doneStatuses = new Set(doneStatusIds);
  const scopedModels: ColumnAgingModel[] = [];
  let reachedStart = false;

  for (const column of boardColumns) {
    const hasStartStatus = column.statusIds.some((statusId) => startStatuses.has(statusId));
    const hasDoneStatus = column.statusIds.some((statusId) => doneStatuses.has(statusId));

    if (!reachedStart && hasStartStatus) {
      reachedStart = true;
    }
    if (!reachedStart) continue;

    const model = modelsByColumn.get(column.name);
    if (model) {
      scopedModels.push(model);
    }

    if (hasDoneStatus) {
      break;
    }
  }

  return scopedModels;
}
