import { costLine } from "@catalog/core/catalog/cost";
import type { BatchCost } from "@catalog/core/catalog/types";
export function batchCostLine(cost:BatchCost){return costLine({cost}).text;}
