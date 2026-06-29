"""
Spark ETL job — runs on EMR Serverless.

Arguments:
  --input   s3://bucket/raw/<tenant>/
  --output  s3://bucket/processed/<tenant>/
  --tenant  <tenant-name>
"""
import argparse
from pyspark.sql import SparkSession
from pyspark.sql import functions as F


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tenant", required=True)
    return parser.parse_args()


def main():
    args = parse_args()

    spark = (
        SparkSession.builder
        .appName(f"ETL-{args.tenant}")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config("spark.sql.catalog.glue_catalog", "org.apache.iceberg.spark.SparkCatalog")
        .config("spark.sql.catalog.glue_catalog.warehouse", args.output)
        .config("spark.sql.catalog.glue_catalog.catalog-impl", "org.apache.iceberg.aws.glue.GlueCatalog")
        .getOrCreate()
    )

    df = spark.read.option("header", True).option("inferSchema", True).csv(args.input)

    df_clean = (
        df
        .dropDuplicates()
        .filter(F.col("amount").isNotNull() & (F.col("amount") > 0))
        .withColumn("processed_at", F.current_timestamp())
        .withColumn("tenant",       F.lit(args.tenant))
    )

    (
        df_clean
        .write
        .mode("overwrite")
        .partitionBy("tenant")
        .parquet(args.output)
    )

    count = df_clean.count()
    print(f"ETL complete: {count} rows written to {args.output}")
    spark.stop()


if __name__ == "__main__":
    main()
