(function (root) {
  'use strict';
  const BeeStore = root.BeeStore || (root.BeeStore = {});

  class EmployeesService {
    constructor(repo) {
      this.repo = repo;
    }

    /** Lists all employees.
     * @returns {Promise<Array>} All employee records. */
    async list() {
      return this.repo.list('employees');
    }

    /** Fetches a single employee by id.
     * @param {string} id Employee id.
     * @returns {Promise<Object|undefined>} Employee record or undefined. */
    async get(id) {
      return this.repo.get('employees', id);
    }

    /** Creates an employee with defaults (hire date, salary, active).
     * @param {Object} data Employee fields (name, baseSalaryMinor, hireDate).
     * @returns {Promise<Object>} Created employee record. */
    async create(data) {
      return this.repo.transaction(async (tx) => {
        const emp = {
          id: BeeStore.ids.randomId('emp'),
          name: data.name,
          phone: data.phone || '',
          position: data.position || '',
          hireDate: data.hireDate || BeeStore.dates.today(),
          baseSalaryMinor: BeeStore.money.roundMinor(data.baseSalaryMinor || 0),
          active: data.active !== false,
          notes: data.notes || '',
          createdAt: BeeStore.dates.now(),
          updatedAt: BeeStore.dates.now(),
        };
        tx.put('employees', emp);
        return emp;
      });
    }

    /** Updates an employee by merging the patch.
     * @param {string} id Employee id. @param {Object} patch Fields to update.
     * @returns {Promise<Object>} Updated record. @throws {BeeError} NOT_FOUND if missing. */
    async update(id, patch) {
      return this.repo.transaction(async (tx) => {
        const e = await tx.get('employees', id);
        if (!e) throw BeeStore.errors.err('NOT_FOUND', 'الموظف غير موجود');
        const updated = { ...e, ...patch, id, updatedAt: BeeStore.dates.now() };
        tx.put('employees', updated);
        return updated;
      });
    }

    /** Soft-deactivates an employee (sets active false).
     * @param {string} id Employee id.
     * @returns {Promise<Object>} Updated record. @throws {BeeError} NOT_FOUND if missing. */
    async deactivate(id) {
      return this.update(id, { active: false });
    }
  }

  BeeStore.employees = new EmployeesService(null);
  BeeStore.EmployeesService = EmployeesService;
  if (typeof module !== 'undefined') module.exports = EmployeesService;
})(typeof window !== 'undefined' ? window : globalThis);
