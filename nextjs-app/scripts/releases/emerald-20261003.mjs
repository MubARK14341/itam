import {renderReleaseConfig as render, prepareRelease as prepare} from './publication-package.mjs';
export const RELEASE=Object.freeze({"id": "emerald-20261003", "projectId": "fixture-review", "orgId": "fixture-org", "projectName": "fixture-review", "officialHost": "emerald-20261003.example.invalid", "supabaseOrigin": "https://demo.invalid"});
/** @param {string} source @param {{id:string,projectId:string,orgId:string,projectName:string,officialHost:string,supabaseOrigin:string}} [release] */
export function renderReleaseConfig(source,release=RELEASE){return render(source,release);}
/** @param {string} root @param {string} destination @param {{id:string,projectId:string,orgId:string,projectName:string,officialHost:string,supabaseOrigin:string}} [release] */
export function prepareRelease(root,destination,release=RELEASE){return prepare(root,destination,release);}
