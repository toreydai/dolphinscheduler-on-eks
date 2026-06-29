"""
Data quality check using PyDeequ — runs on EMR Serverless after ETL.

Arguments:
  --input   s3://bucket/processed/<tenant>/
  --tenant  <tenant-name>
  --report  s3://bucket/dq-reports/<tenant>/

Exit code 1 if any check fails — DolphinScheduler treats this as task failure.
"""
import argparse
import os
from pyspark.sql import SparkSession
import pydeequ
from pydeequ.checks import Check, CheckLevel
from pydeequ.verification import VerificationSuite, VerificationResult


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  required=True)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args()


def main():
    args = parse_args()

    # The deequ Scala jar and the pydeequ Python package are supplied at
    # spark-submit time (--jars / --py-files, pointing at pre-built artifacts
    # in S3) rather than here via spark.jars.packages — EMR Serverless has no
    # internet egress to resolve Maven coordinates at runtime, verified live
    # (java.net.ConnectException: Connection timed out reaching
    # repo1.maven.org / repos.spark-packages.org).
    spark = SparkSession.builder.appName(f"DQ-{args.tenant}").getOrCreate()

    df = spark.read.parquet(args.input)

    check = (
        Check(spark, CheckLevel.Error, f"Quality Check — {args.tenant}")
        .hasSize(lambda n: n > 0,            "Dataset must not be empty")
        .isComplete("amount",                "amount must have no nulls")
        .isComplete("tenant",                "tenant must have no nulls")
        .satisfies("amount > 0",             "Positive amount", lambda f: f >= 1.0)
        .isContainedIn("tenant", [args.tenant], hint="Tenant isolation check")
        .isUnique("record_id" if "record_id" in df.columns else "amount",
                  "No duplicate values")
    )

    result = VerificationSuite(spark).onData(df).addCheck(check).run()
    result_df = VerificationResult.checkResultsAsDataFrame(spark, result)

    # Write quality report to S3
    result_df.coalesce(1).write.mode("overwrite").json(args.report)

    failed = result_df.filter("constraint_status != 'Success'")
    failed_count = failed.count()

    if failed_count > 0:
        print(f"DATA QUALITY FAILED: {failed_count} check(s) did not pass")
        failed.show(truncate=False)
        spark.stop()
        # pydeequ's assertion callbacks start a non-daemon py4j callback
        # server thread that keeps the process alive after sys.exit() —
        # verified live (job stayed RUNNING for 10+ min after SparkContext
        # had already logged a clean stop). os._exit() bypasses that.
        os._exit(1)

    total = result_df.count()
    print(f"Data quality passed: {total}/{total} checks succeeded")
    spark.stop()
    os._exit(0)


if __name__ == "__main__":
    main()
