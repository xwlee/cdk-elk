import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as es from "aws-cdk-lib/aws-elasticsearch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { EbsDeviceVolumeType } from "aws-cdk-lib/aws-ec2";
import { ArnPrincipal, Effect } from "aws-cdk-lib/aws-iam";

export class CdkElkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${Stack.of(this).stackName}UserPool`,
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          mutable: true,
          required: true,
        },
      },
    });
    userPool.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: "cdk-elk",
      },
    });

    const identityPool = new cognito.CfnIdentityPool(this, "IdentityPool", {
      identityPoolName: `${Stack.of(this).stackName}IdentityPool`,
      allowUnauthenticatedIdentities: false,
    });

    // See https://docs.aws.amazon.com/cognito/latest/developerguide/role-based-access-control.html
    const authenticatedRole = new iam.Role(this, "AuthenticatedRole", {
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "IdentityPoolRoleAttachment",
      {
        identityPoolId: identityPool.ref,
        roles: {
          authenticated: authenticatedRole.roleArn,
        },
      }
    );

    // Allow Amazon ES to access Cognito
    const esRole = new iam.Role(this, "EsRole", {
      assumedBy: new iam.ServicePrincipal("es.amazonaws.com"),
    });
    esRole.addManagedPolicy({
      managedPolicyArn: "arn:aws:iam::aws:policy/AmazonESCognitoAccess",
    });

    const domain = new es.Domain(this, "Elasticsearch", {
      domainName: "cdk-elk",
      version: es.ElasticsearchVersion.V7_10,
      enableVersionUpgrade: true, // This allow in-place Elasticsearch version upgrade
      capacity: {
        dataNodeInstanceType: "t3.small.elasticsearch",
        dataNodes: 1, // For testing purpose, we only create 1 instance
      },
      ebs: {
        // Attach a 30GB GP2 volume
        enabled: true,
        volumeSize: 30,
        volumeType: EbsDeviceVolumeType.GP2,
      },
      accessPolicies: [
        // Allow authenticated users to access Kibana
        new iam.PolicyStatement({
          effect: Effect.ALLOW,
          principals: [new ArnPrincipal(authenticatedRole.roleArn)],
          actions: ["es:ESHttp*"],
          resources: [
            `arn:aws:es:${Stack.of(this).region}:${
              Stack.of(this).account
            }:domain/cdk-elk/*`,
          ],
        }),
      ],
      cognitoKibanaAuth: {
        userPoolId: userPool.userPoolId,
        identityPoolId: identityPool.ref,
        role: esRole,
      },
    });
  }
}
