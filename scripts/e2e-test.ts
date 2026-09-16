import { MongoMemoryServer } from "mongodb-memory-server";
import dotenv from "dotenv";
import app from "../src/app";
import { connectDB } from "../src/config/db";

async function main() {
  console.log("Starting in-memory MongoDB…");
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri("nca-test");
  process.env.JWT_SECRET = "test-secret";
  process.env.SEED_TEACHER_EMAIL = "teacher@test.com";
  process.env.SEED_TEACHER_PASSWORD = "teacherpass";

  await connectDB();

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://localhost:${port}`;

  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, extra = "") => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.log(`  ✗ FAIL ${name} ${extra}`);
    }
  };

  const req = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  console.log("1. Health");
  const health = await req("GET", "/api/ping");
  check("ping", health.status === 200, JSON.stringify(health));

  console.log("2. Auth");
  const bad = await req("POST", "/auth/login", { email: "teacher@test.com", password: "wrong" });
  check("login rejects bad password", bad.status === 401);

  const login = await req("POST", "/auth/login", { email: "teacher@test.com", password: "teacherpass" });
  check("teacher login works", login.status === 200 && login.data.token, JSON.stringify(login.data));

  const teacherToken: string = login.data.token;
  const me = await req("GET", "/auth/me", undefined, teacherToken);
  check("teacher /me returns role", me.data.user.role === "teacher");

  const unprotected = await req("GET", "/students");
  check("students requires auth", unprotected.status === 401);

  console.log("3. Teacher creates student");
  const create = await req("POST", "/auth/register", { name: "Amina Student", email: "amina@student.com", password: "student123" }, teacherToken);
  check("register student via teacher", create.status === 201, JSON.stringify(create.data));

  const noAuthRegister = await req("POST", "/auth/register", { name: "X", email: "x@x.com", password: "xxxxxx" });
  check("register requires teacher auth", noAuthRegister.status === 401);

  const students = await req("GET", "/students", undefined, teacherToken);
  check("teacher lists students", students.status === 200 && students.data.length === 1);

  const studentId: string = create.data.user.id;

  const studentLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "student123" });
  check("student login works", studentLogin.status === 200);
  const studentToken: string = studentLogin.data.token;

  console.log("4. Teacher CRUD (exams, homework, lessons, payments)");
  const exam = await req("POST", "/api/exams", { studentId, subject: "Coding", title: "Unit 1", grade: 18, maxGrade: 20 }, teacherToken);
  check("teacher creates exam", exam.status === 201, JSON.stringify(exam.data));

  const hw = await req("POST", "/api/homework", { studentId, title: "Ch 2", points: 8, maxPoints: 10 }, teacherToken);
  check("teacher creates homework", hw.status === 201);

  const lesson = await req("POST", "/api/lessons", { title: "Intro JS", youtubeVideoId: "https://youtu.be/dQw4w9WgXcQ", module: "Module 1", order: 1 }, teacherToken);
  check("teacher creates lesson (URL extracted)", lesson.status === 201 && lesson.data.youtubeVideoId === "dQw4w9WgXcQ", JSON.stringify(lesson.data));

  const payment = await req("POST", "/api/payments", { studentId, month: "2026-09", amount: 500, status: "unpaid" }, teacherToken);
  check("teacher creates payment", payment.status === 201, JSON.stringify(payment.data));

  const paidUpdate = await req("PUT", `/api/payments/${payment.data._id}`, { status: "paid" }, teacherToken);
  check("mark payment paid", paidUpdate.status === 200 && paidUpdate.data.status === "paid" && !!paidUpdate.data.paidOn);

  console.log("5. Student access control");
  const studentAttemptTeacherOnly = await req("POST", "/api/exams", { studentId, subject: "X", title: "Hack", grade: 20, maxGrade: 20 }, studentToken);
  check("student cannot create exams", studentAttemptTeacherOnly.status === 403);

  const profile = await req("GET", "/api/students/me", undefined, studentToken);
  check("student profile aggregates data", profile.status === 200, JSON.stringify(profile.data));
  check("profile has exam", profile.data.exams.length === 1);
  check("profile has homework", profile.data.homeworks.length === 1);
  check("profile has payment", profile.data.payments.length === 1);
  check("profile shows only published lessons", profile.data.lessons.length === 1);
  check("current payment is paid", profile.data.currentPayment.status === "paid");

  const draftLesson = await req("POST", "/api/lessons", { title: "Draft", youtubeVideoId: "abc", module: "Module 1", order: 2, published: false }, teacherToken);
  check("teacher creates draft lesson", draftLesson.status === 201);
  const profile2 = await req("GET", "/api/students/me", undefined, studentToken);
  check("draft lesson hidden from student", profile2.data.lessons.length === 1);

  console.log("6. Student identity isolation");
  await req("POST", "/auth/register", { name: "Bassem", email: "bassem@student.com", password: "student123" }, teacherToken);
  const bassemLogin = await req("POST", "/auth/login", { email: "bassem@student.com", password: "student123" });
  const bassemToken: string = bassemLogin.data.token;
  const bassemProfile = await req("GET", "/api/students/me", undefined, bassemToken);
  check("second student sees no data", bassemProfile.data.exams.length === 0 && bassemProfile.data.payments.length === 0);

  await req("POST", "/api/payments", { studentId: bassemProfile.data.user.id, month: "2026-08", amount: 500, status: "late" }, teacherToken);
  const unpaidList = await req("GET", "/api/payments", undefined, teacherToken);
  check("teacher payment list covers all", unpaidList.data.length === 2, JSON.stringify(unpaidList.data));

  console.log("7. Password management");
  const wrongCurrent = await req("PUT", "/auth/password", { currentPassword: "nope", newPassword: "newpass1" }, studentToken);
  check("self change rejects wrong current password", wrongCurrent.status === 401);

  const selfChange = await req("PUT", "/auth/password", { currentPassword: "student123", newPassword: "newpass1" }, studentToken);
  check("student changes own password", selfChange.status === 200);

  const relogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "newpass1" });
  check("student logs in with new password", relogin.status === 200);
  const studentToken2: string = relogin.data.token;

  const shortPass = await req("PUT", `/api/students/${studentId}/password`, { password: "123" }, teacherToken);
  check("teacher reset rejects short password", shortPass.status === 400);

  const reset = await req("PUT", `/api/students/${studentId}/password`, { password: "resetpass" }, teacherToken);
  check("teacher resets student password", reset.status === 200);

  const resetLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("student logs in with reset password", resetLogin.status === 200);

  const studentForbidReset = await req("PUT", `/api/students/${studentId}/password`, { password: "whatever1" }, studentToken2);
  check("student cannot reset other accounts", studentForbidReset.status === 403);

  const studentForbidDelete = await req("DELETE", `/api/students/${studentId}`, undefined, studentToken2);
  check("student cannot delete accounts", studentForbidDelete.status === 403);

  console.log("8. Teacher deletes student (soft delete keeps data)");
  const del = await req("DELETE", `/api/students/${studentId}`, undefined, teacherToken);
  check("teacher deactivates student", del.status === 200);

  const del2 = await req("DELETE", `/api/students/${studentId}`, undefined, teacherToken);
  check("deactivating again returns 400", del2.status === 400);

  const keptProfile = await req("GET", `/api/students/${studentId}`, undefined, teacherToken);
  check("deactivated student's data is kept", keptProfile.status === 200 && keptProfile.data.payments.length === 1);

  const goneLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("deactivated student cannot log in", goneLogin.status === 401);

  const restoreRes = await req("PUT", `/api/students/${studentId}/restore`, undefined, teacherToken);
  check("teacher restores student", restoreRes.status === 200);

  const restoredLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("restored student can log in", restoredLogin.status === 200);

  server.close();
  await mongod.stop();

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});