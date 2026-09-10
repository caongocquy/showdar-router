import { makeKv } from "../helpers/kvStore.js";

const routeHealthKv = makeKv("routeHealth");

export function getRouteHealth(model) {
  return routeHealthKv.get(model, null);
}

export function getAllRouteHealth() {
  return routeHealthKv.getAll();
}

export function setRouteHealth(model, record) {
  return routeHealthKv.set(model, record);
}

export function removeRouteHealth(model) {
  return routeHealthKv.remove(model);
}

export function clearRouteHealth() {
  return routeHealthKv.clear();
}
