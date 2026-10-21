import {describe,expect,it} from 'vitest';
import {createSeed} from './seed';

describe('publication fixture privacy',()=>{
 it('uses explicit synthetic labels for employee and customer contacts',()=>{
  const {tables}=createSeed();
  expect(tables.employees.length).toBeGreaterThan(0);
  for(const row of tables.employees){
   expect(row.full_name).toMatch(/^موظف تجريبي \d+$/);
   expect(row.full_name_ar).toBe(row.full_name);
  }
  for(const row of tables.customers)expect(row.contact_person).toMatch(/^جهة اتصال تجريبية \d+$/);
  for(const row of tables.suppliers)expect(row.contact_person).toMatch(/^جهة اتصال مورد تجريبية \d+$/);
 });
 it('keeps seeded phone and email contacts non-routable',()=>{
  const {tables}=createSeed();
  for(const table of ['employees','customers','suppliers','customer_portal_users']){
   for(const row of tables[table]){
    expect(row.phone).toBe('0000000000');
    if(row.email)expect(row.email).toMatch(/@demo\.invalid$/);
   }
  }
 });
});
