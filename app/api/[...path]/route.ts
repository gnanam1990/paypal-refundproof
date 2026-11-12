import { appRuntime } from '../../../src/server/app-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handle = (req: Request) => appRuntime().handle(req);
export { handle as GET, handle as POST };
