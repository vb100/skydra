import { createContext, useContext } from 'react';

/**
 * A completed case is read-only until it is reopened (client answer Q26). Panels hide the
 * actions that change it; the database refuses them in any case.
 */
export const CaseLockContext = createContext(false);
export const useCaseLocked = () => useContext(CaseLockContext);
